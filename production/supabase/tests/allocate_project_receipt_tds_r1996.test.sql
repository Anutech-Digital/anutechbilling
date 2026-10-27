-- R-1996 (27 Oct 2026, G-RECON) — TDS inside the one-Save project receipt:
-- public.allocate_project_receipt_with_tds(bank line, project, [{milestone_id, amount, raise_invoice}],
--   {section, rate_pct, amount[, base]}, received_at, reference).
-- Source: R-1910 audit case 5 (drafts/R-1910/c5_tds.sql) — record_project_receipt_with_tds takes ONE
-- milestone; a receipt that settles several kists less TDS had no path. Decision (audit): the TDS is
-- split pro-rata on what each kist settles, rounding on the last row.
--
-- Owner's path (UI comes with R-1998): Banking → ₹2,12,400 money-in line → Reconcile → Project payment
-- → tick kist 1 + kist 2 → "TDS deducted?" ₹23,600 (194J 10%) → Save.
--
--   1. ₹2,12,400 bank + ₹23,600 TDS settles 2 × ₹1,18,000 → both kists Paid, both invoices Paid with
--      paid_amount ₹1,18,000, TDS receivable ₹23,600 as 2 rows of ₹11,800 each linked to its invoice,
--      line reconciled once; Balance Sheet: bank +₹2,12,400, TDS receivable +₹23,600, Undeposited 0
--      (R-1992 rule — no double count), project receivable 0; assets added = invoiced ₹2,36,000.
--   2. Card doneWhen: 2 × ₹5,90,000, ₹10,80,000 bank + ₹1,00,000 TDS (10% of ₹10,00,000 taxable) →
--      2 rows of ₹50,000, base ₹5,00,000 each.
--   3. 2% (c5's 194C case, now through the new RPC): ₹1,18,000 kist = ₹1,16,000 + ₹2,000.
--   4. Rounding: 3 × ₹1,00,000, TDS ₹5,000 → ₹1,666 / ₹1,666 / ₹1,668 — sums exactly.
--   5. Part payment with TDS, invoice ticked: ₹53,100 + ₹5,900 on a ₹1,18,000 kist → split, invoice
--      ₹59,000 Paid, the TDS row carries that invoice (was NULL — audit c5 "also noted").
--   6. Refused, nothing written: bank + TDS more than the kists ticked; TDS not a whole rupee / ≤ 0;
--      TDS as big as the whole settlement; no rate; a sales user.
--   7. The old 5-argument allocate_project_receipt still books a receipt with no TDS.
-- Fails before 20261027005624_r1996_allocate_project_receipt_tds (the function does not exist).
begin;

create function pg_temp.r1996_fill_supplier() returns trigger language plpgsql as $r$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, Delhi');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $r$;
create trigger zz_r1996_supplier before insert on public.tenants
  for each row execute function pg_temp.r1996_fill_supplier();

insert into public.tenants (id, name, email, state_code) values
  ('f1996000-0000-4000-8000-000000000001', 'R1996 TEST CO', 'r1996@test.invalid', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('f1996000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1996-owner@test.invalid'),
  ('f1996000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1996-sales@test.invalid');
insert into public.users (id, tenant_id, email, role) values
  ('f1996000-0000-4000-8000-0000000000a1', 'f1996000-0000-4000-8000-000000000001', 'r1996-owner@test.invalid', 'owner'),
  ('f1996000-0000-4000-8000-0000000000a2', 'f1996000-0000-4000-8000-000000000001', 'r1996-sales@test.invalid', 'sales');
insert into public.customers (id, tenant_id, name, state_code) values
  ('f1996000-0000-4000-8000-0000000000c1', 'f1996000-0000-4000-8000-000000000001', 'R1996 Demo Client', '07');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('f1996000-0000-4000-8000-0000000000b1', 'f1996000-0000-4000-8000-000000000001', 'R1996 HDFC', 'HDFC', 0, '2026-04-01');

create function pg_temp.as_user(p_user text) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$f$;
select pg_temp.as_user('f1996000-0000-4000-8000-0000000000a1');

create temp table ids (k text primary key, v text);

create function pg_temp.txn(p_amount int, p_date date, p_desc text) returns uuid language sql as $f$
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source)
  values ('f1996000-0000-4000-8000-000000000001', 'f1996000-0000-4000-8000-0000000000b1', p_date, p_desc,
          'UTR' || substr(md5(p_desc || p_amount), 1, 10), 0, p_amount, 'manual')
  returning id;
$f$;

-- A project sold the normal way (quotation → accepted), 18% GST, GST-inclusive milestones.
create function pg_temp.project(p_title text, p_ms int[]) returns uuid language plpgsql as $f$
declare v_pid uuid; v_ms jsonb := '[]'; v_total int := 0; i int;
begin
  for i in 1 .. array_length(p_ms, 1) loop
    v_ms := v_ms || jsonb_build_array(jsonb_build_object('label', 'Kist ' || i, 'total_amount', p_ms[i],
                                                         'due_date', (date '2026-10-01' + (i - 1) * 30)));
    v_total := v_total + p_ms[i];
  end loop;
  v_pid := public.create_project_quote('f1996000-0000-4000-8000-0000000000c1', 'R1996 Demo Client',
             p_title, null, jsonb_build_array(jsonb_build_object('name', p_title, 'qty', 1,
             'rate', round(v_total * 100.0 / 118), 'amount', round(v_total * 100.0 / 118))),
             18, false, v_ms);
  perform public.accept_project_quote(v_pid);
  return v_pid;
end $f$;

create function pg_temp.ms(p_project uuid, p_seq int) returns uuid language sql as $f$
  select id from public.project_milestones where project_id = p_project and seq = p_seq;
$f$;
create function pg_temp.ms_paid(p_ms uuid) returns int language sql as $f$
  select coalesce(sum(amount), 0)::int from public.project_payments where milestone_id = p_ms;
$f$;
create function pg_temp.alloc(variadic p jsonb[]) returns jsonb language sql as $f$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from unnest(p) x;
$f$;
create function pg_temp.a(p_ms uuid, p_amount int, p_invoice boolean default true) returns jsonb language sql as $f$
  select jsonb_build_object('milestone_id', p_ms, 'amount', p_amount, 'raise_invoice', p_invoice);
$f$;
create function pg_temp.tds(p_amount numeric, p_rate numeric default 10, p_section text default '194J') returns jsonb language sql as $f$
  select jsonb_build_object('section', p_section, 'rate_pct', p_rate, 'amount', p_amount);
$f$;
create function pg_temp.inv_of(p_ms uuid) returns text language sql as $f$
  select invoice_id from public.project_milestones where id = p_ms;
$f$;

create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $f$
begin
  if not coalesce(p_ok, false) then raise exception 'R-1996 FAIL: %', p_msg; end if;
  raise notice 'ok  : %', p_msg;
end $f$;

create temp table snap (k text primary key, cash bigint, undeposited bigint, project_receivable bigint, tds bigint, advances bigint);
create function pg_temp.snap(p_k text) returns void language sql as $f$
  insert into snap
  select p_k, b.cash_and_bank, b.undeposited_funds, b.project_receivable, b.tds_receivable, b.advances_from_customers
    from public.report_balance_sheet(public.ist_today()) b
  on conflict (k) do update set cash = excluded.cash, undeposited = excluded.undeposited,
    project_receivable = excluded.project_receivable, tds = excluded.tds, advances = excluded.advances;
$f$;

-- Must be refused; the message must contain p_word. Nothing may be written: no project payment on
-- the line, the line unreconciled, no new TDS receivable row.
create function pg_temp.must_refuse(p_sql text, p_what text, p_word text, p_line uuid) returns void language plpgsql as $f$
declare v_msg text; v_state text; v_tds_before int;
begin
  select count(*) into v_tds_before from public.tds_receivable where tenant_id = 'f1996000-0000-4000-8000-000000000001';
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    if v_msg not ilike '%' || p_word || '%' then
      raise exception 'R-1996 FAIL: % — refused, but the message does not say "%": %', p_what, p_word, v_msg;
    end if;
    if exists (select 1 from public.project_payments where bank_txn_id = p_line)
       or (select matched_to_type from public.bank_transactions where id = p_line) is not null
       or (select count(*) from public.tds_receivable where tenant_id = 'f1996000-0000-4000-8000-000000000001') <> v_tds_before then
      raise exception 'R-1996 FAIL: % — refused, but something was written', p_what;
    end if;
    raise notice 'ok  : % (refused % : %)', p_what, v_state, v_msg;
    return;
  end;
  raise exception 'R-1996 FAIL: % — it was ACCEPTED', p_what;
end $f$;

-- ── 1. the owner's case: ₹2,12,400 + ₹23,600 TDS (10%) settles 2 × ₹1,18,000 ────────────────
do $$
declare v_p uuid; v_m1 uuid; v_m2 uuid; v_t uuid; r jsonb; i1 record; i2 record; t record;
        x record; y record; v_rows record;
begin
  perform pg_temp.snap('c1_before');
  v_p  := pg_temp.project('T1 App build', array[118000, 118000]);
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2);
  v_t  := pg_temp.txn(212400, date '2026-10-07', 'RTGS-R1996 DEMO CLIENT-KIST 1+2 LESS TDS');

  r := public.allocate_project_receipt_with_tds(v_t, v_p,
         pg_temp.alloc(pg_temp.a(v_m1, 118000), pg_temp.a(v_m2, 118000)), pg_temp.tds(23600, 10, '194J'), null, null);

  perform pg_temp.check(pg_temp.ms_paid(v_m1) = 118000 and pg_temp.ms_paid(v_m2) = 118000,
    format('c1: each kist settled ₹1,18,000 (got %s / %s)', pg_temp.ms_paid(v_m1), pg_temp.ms_paid(v_m2)));
  perform pg_temp.check((select bool_and(status = 'paid') from public.project_milestones where id in (v_m1, v_m2)),
    'c1: both kists Paid');
  perform pg_temp.check((select count(*) = 2 and bool_and(amount = 106200) and bool_and(bank_txn_id = v_t)
                           from public.project_payments where project_id = v_p and coalesce(method, '') <> 'tds'),
    'c1: bank part ₹1,06,200 per kist, both on this bank line');
  perform pg_temp.check((select count(*) = 2 and bool_and(amount = 11800) and bool_and(bank_txn_id is null)
                           from public.project_payments where project_id = v_p and method = 'tds'),
    'c1: TDS part ₹11,800 per kist, method tds, no bank line');
  select * into i1 from public.invoices where id = pg_temp.inv_of(v_m1);
  select * into i2 from public.invoices where id = pg_temp.inv_of(v_m2);
  perform pg_temp.check(i1.amount = 118000 and i1.status::text = 'paid' and i1.paid_amount = 118000
                        and i2.amount = 118000 and i2.status::text = 'paid' and i2.paid_amount = 118000,
    format('c1: both invoices ₹1,18,000 Paid, paid_amount ₹1,18,000 (got %s %s %s / %s %s %s)',
           i1.amount, i1.status, i1.paid_amount, i2.amount, i2.status, i2.paid_amount));
  select count(*) as n, sum(tds_amount) as tds, sum(net_paid) as net,
         count(*) filter (where invoice_id = i1.id and tds_amount = 11800 and net_paid = 106200) as r1,
         count(*) filter (where invoice_id = i2.id and tds_amount = 11800 and net_paid = 106200) as r2,
         bool_and(section = '194J' and rate_pct = 10 and status = 'pending_cert'
                  and customer_id = 'f1996000-0000-4000-8000-0000000000c1'
                  and payment_received_date = date '2026-10-07') as meta
    into v_rows
    from public.tds_receivable
   where tenant_id = 'f1996000-0000-4000-8000-000000000001' and invoice_id in (i1.id, i2.id);
  perform pg_temp.check(v_rows.n = 2 and v_rows.tds = 23600 and v_rows.net = 212400 and v_rows.r1 = 1 and v_rows.r2 = 1 and v_rows.meta,
    format('c1: TDS receivable ₹23,600 = ₹11,800 + ₹11,800, one row per invoice, 194J 10%%, bank day (got %s rows, ₹%s)', v_rows.n, v_rows.tds));
  select * into t from public.bank_transactions where id = v_t;
  perform pg_temp.check(t.matched_to_type = 'project' and t.matched_to_id = (r->'allocations'->0->>'payment_id'),
    'c1: the bank line is reconciled once, to kist 1''s bank payment');
  perform pg_temp.check((r->>'total')::int = 236000 and (r->>'tds')::int = 23600 and jsonb_array_length(r->'allocations') = 2
                        and (r->'allocations'->1->>'tds')::int = 11800 and (r->'allocations'->1->>'tds_receivable') is not null,
    'c1: result lists total, TDS and each kist''s TDS row');

  -- GL — R-1992 rule: the TDS part is not cash; it sits only in TDS receivable.
  perform pg_temp.snap('c1_after');
  select * into x from snap where k = 'c1_before';
  select * into y from snap where k = 'c1_after';
  perform pg_temp.check(y.cash - x.cash = 212400, format('c1 GL: bank +₹2,12,400 (got %s)', y.cash - x.cash));
  perform pg_temp.check(y.tds - x.tds = 23600, format('c1 GL: TDS receivable +₹23,600 (got %s)', y.tds - x.tds));
  perform pg_temp.check(y.undeposited - x.undeposited = 0, format('c1 GL: Undeposited funds unchanged — no double count (got %s)', y.undeposited - x.undeposited));
  perform pg_temp.check(y.project_receivable - x.project_receivable = 0 and y.advances - x.advances = 0,
    format('c1 GL: nothing receivable, no advance (got %s / %s)', y.project_receivable - x.project_receivable, y.advances - x.advances));
  perform pg_temp.check((y.cash - x.cash) + (y.undeposited - x.undeposited) + (y.project_receivable - x.project_receivable)
                        + (y.tds - x.tds) - (y.advances - x.advances) = i1.amount + i2.amount,
    'c1 GL balanced: assets added (bank + TDS receivable) = invoiced ₹2,36,000');
end $$;

-- ── 2. card doneWhen: 2 × ₹5,90,000 = ₹10,80,000 bank + ₹1,00,000 TDS (10% of ₹10,00,000) ───
do $$
declare v_p uuid; v_m1 uuid; v_m2 uuid; v_t uuid; v_rows record;
begin
  v_p  := pg_temp.project('T2 ERP', array[590000, 590000]);
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2);
  v_t  := pg_temp.txn(1080000, date '2026-10-12', 'NEFT-R1996 DEMO CLIENT-ERP LESS TDS');
  perform public.allocate_project_receipt_with_tds(v_t, v_p,
            pg_temp.alloc(pg_temp.a(v_m1, 590000), pg_temp.a(v_m2, 590000)), pg_temp.tds(100000), date '2026-10-12', 'NEFT less TDS');
  perform pg_temp.check((select bool_and(status = 'paid') from public.project_milestones where id in (v_m1, v_m2)), 'c2: both ₹5,90,000 kists Paid');
  select count(*) as n, bool_and(tds_amount = 50000 and gross_amount = 500000 and net_paid = 540000) as each_ok,
         count(distinct invoice_id) as invs
    into v_rows from public.tds_receivable where invoice_id in (pg_temp.inv_of(v_m1), pg_temp.inv_of(v_m2));
  perform pg_temp.check(v_rows.n = 2 and v_rows.each_ok and v_rows.invs = 2,
    format('c2: 2 TDS rows of ₹50,000 on ₹5,00,000 taxable each, one per invoice (got %s rows)', v_rows.n));
  perform pg_temp.check((select bool_and(status::text = 'paid' and paid_amount = 590000) from public.invoices
                          where id in (pg_temp.inv_of(v_m1), pg_temp.inv_of(v_m2))), 'c2: both invoices Paid ₹5,90,000');
end $$;

-- ── 3. 2% (194C) — c5's second case through the new RPC ────────────────────────────────────
do $$
declare v_p uuid; v_m uuid; v_t uuid; v_row record;
begin
  v_p := pg_temp.project('T3 Support contract', array[118000]);
  v_m := pg_temp.ms(v_p, 1);
  v_t := pg_temp.txn(116000, date '2026-10-13', 'UPI-R1996 DEMO CLIENT-SUPPORT');
  perform public.allocate_project_receipt_with_tds(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m, 118000)), pg_temp.tds(2000, 2, '194C'), null, null);
  select * into v_row from public.tds_receivable where invoice_id = pg_temp.inv_of(v_m);
  perform pg_temp.check((select status from public.project_milestones where id = v_m) = 'paid'
                        and v_row.tds_amount = 2000 and v_row.section = '194C' and v_row.rate_pct = 2 and v_row.gross_amount = 100000,
    format('c3: 2%% kist Paid, TDS ₹2,000 194C on ₹1,00,000 (got %s %s %s)', v_row.tds_amount, v_row.section, v_row.gross_amount));
end $$;

-- ── 4. rounding: 3 × ₹1,00,000, TDS ₹5,000 → ₹1,666 / ₹1,666 / ₹1,668 ─────────────────────
do $$
declare v_p uuid; v_m1 uuid; v_m2 uuid; v_m3 uuid; v_t uuid; r jsonb;
begin
  v_p  := pg_temp.project('T4 Retainer', array[100000, 100000, 100000]);
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2); v_m3 := pg_temp.ms(v_p, 3);
  v_t  := pg_temp.txn(295000, date '2026-10-14', 'NEFT-R1996 DEMO CLIENT-RETAINER');
  r := public.allocate_project_receipt_with_tds(v_t, v_p,
         pg_temp.alloc(pg_temp.a(v_m1, 100000, false), pg_temp.a(v_m2, 100000, false), pg_temp.a(v_m3, 100000, false)),
         pg_temp.tds(5000, 2, '194J'), null, null);
  perform pg_temp.check((r->'allocations'->0->>'tds')::int = 1666 and (r->'allocations'->1->>'tds')::int = 1666
                        and (r->'allocations'->2->>'tds')::int = 1668,
    format('c4: TDS split 1666 / 1666 / 1668, rounding on the last (got %s / %s / %s)',
           r->'allocations'->0->>'tds', r->'allocations'->1->>'tds', r->'allocations'->2->>'tds'));
  perform pg_temp.check((select sum(amount) from public.project_payments where project_id = v_p and method = 'tds') = 5000
                        and (select sum(amount) from public.project_payments where project_id = v_p and bank_txn_id = v_t) = 295000,
    'c4: TDS parts sum to exactly ₹5,000, bank parts to exactly the ₹2,95,000 line');
  perform pg_temp.check((select bool_and(status = 'paid') from public.project_milestones where project_id = v_p), 'c4: all three kists Paid');
  perform pg_temp.check((select count(*) = 3 and sum(tds_amount) = 5000 and bool_and(invoice_id is null)
                          from public.tds_receivable where notes like '%T4 Retainer%'),
    'c4: three TDS rows (no invoice ticked → none linked yet)');
end $$;

-- ── 5. part payment with TDS, invoice ticked → split; the TDS row carries the invoice ───────
do $$
declare v_p uuid; v_m uuid; v_t uuid; r jsonb; v_part uuid; i record; v_row record;
begin
  v_p := pg_temp.project('T5 Website', array[118000]);
  v_m := pg_temp.ms(v_p, 1);
  v_t := pg_temp.txn(53100, date '2026-10-15', 'UPI-R1996 DEMO CLIENT-HALF LESS TDS');
  r := public.allocate_project_receipt_with_tds(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m, 59000)), pg_temp.tds(5900), null, null);
  v_part := (r->'allocations'->0->>'milestone_id')::uuid;
  select * into i from public.invoices where id = (r->'allocations'->0->>'invoice_id');
  select * into v_row from public.tds_receivable where id = (r->'allocations'->0->>'tds_receivable');
  perform pg_temp.check(v_part is distinct from v_m and i.amount = 59000 and i.status::text = 'paid' and i.paid_amount = 59000,
    format('c5: kist split, invoice ₹59,000 Paid (got %s %s %s)', i.amount, i.status, i.paid_amount));
  perform pg_temp.check(v_row.invoice_id = i.id and v_row.tds_amount = 5900 and v_row.net_paid = 53100,
    'c5: the TDS row is linked to the part invoice (not NULL)');
  perform pg_temp.check((select total_amount from public.project_milestones where id = v_m) = 59000 and pg_temp.ms_paid(v_m) = 0,
    'c5: ₹59,000 still due on the rest of the kist');
end $$;

-- ── 6. refusals — nothing written ──────────────────────────────────────────────────────────
do $$
declare v_p uuid;
begin
  v_p := pg_temp.project('T6 CRM', array[118000, 118000]);
  insert into ids values ('t6_p', v_p::text), ('t6_m1', pg_temp.ms(v_p, 1)::text), ('t6_m2', pg_temp.ms(v_p, 2)::text),
    ('line', pg_temp.txn(212400, date '2026-10-16', 'IMPS-R1996-212400')::text);
end $$;

-- bank ₹2,12,400 + TDS ₹30,000 = ₹2,42,400, but the kists ticked are ₹2,36,000
select pg_temp.must_refuse(format($q$select public.allocate_project_receipt_with_tds(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000), pg_temp.a(%L, 118000)), pg_temp.tds(30000))$q$,
  (select v from ids where k = 'line'), (select v from ids where k = 't6_p'), (select v from ids where k = 't6_m1'), (select v from ids where k = 't6_m2')),
  'bank + TDS more than the kists ticked', 'TDS', (select v::uuid from ids where k = 'line'));
-- bank ₹2,12,400 + TDS ₹20,000 = ₹2,32,400, less than the kists ticked
select pg_temp.must_refuse(format($q$select public.allocate_project_receipt_with_tds(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000), pg_temp.a(%L, 118000)), pg_temp.tds(20000))$q$,
  (select v from ids where k = 'line'), (select v from ids where k = 't6_p'), (select v from ids where k = 't6_m1'), (select v from ids where k = 't6_m2')),
  'bank + TDS less than the kists ticked', 'TDS', (select v::uuid from ids where k = 'line'));
select pg_temp.must_refuse(format($q$select public.allocate_project_receipt_with_tds(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000), pg_temp.a(%L, 118000)), pg_temp.tds(23600.5))$q$,
  (select v from ids where k = 'line'), (select v from ids where k = 't6_p'), (select v from ids where k = 't6_m1'), (select v from ids where k = 't6_m2')),
  'TDS in paise', 'whole-rupee', (select v::uuid from ids where k = 'line'));
select pg_temp.must_refuse(format($q$select public.allocate_project_receipt_with_tds(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000), pg_temp.a(%L, 118000)), pg_temp.tds(0))$q$,
  (select v from ids where k = 'line'), (select v from ids where k = 't6_p'), (select v from ids where k = 't6_m1'), (select v from ids where k = 't6_m2')),
  'TDS ₹0', 'whole-rupee', (select v::uuid from ids where k = 'line'));
select pg_temp.must_refuse(format($q$select public.allocate_project_receipt_with_tds(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000), pg_temp.a(%L, 118000)), jsonb_build_object('section', '194J', 'amount', 23600))$q$,
  (select v from ids where k = 'line'), (select v from ids where k = 't6_p'), (select v from ids where k = 't6_m1'), (select v from ids where k = 't6_m2')),
  'TDS with no rate', 'rate', (select v::uuid from ids where k = 'line'));
select pg_temp.as_user('f1996000-0000-4000-8000-0000000000a2');
select pg_temp.must_refuse(format($q$select public.allocate_project_receipt_with_tds(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000), pg_temp.a(%L, 118000)), pg_temp.tds(23600))$q$,
  (select v from ids where k = 'line'), (select v from ids where k = 't6_p'), (select v from ids where k = 't6_m1'), (select v from ids where k = 't6_m2')),
  'a sales user (role gate)', 'Only an owner', (select v::uuid from ids where k = 'line'));
select pg_temp.as_user('f1996000-0000-4000-8000-0000000000a1');

do $$ begin
  perform pg_temp.check((select count(*) from public.project_payments where project_id = (select v::uuid from ids where k = 't6_p')) = 0,
    'refusals: T6 project untouched (no payment)');
end $$;

-- ── 7. the 5-argument allocate_project_receipt (R-1995 callers) still works, no TDS ─────────
do $$
declare v_p uuid; v_m uuid; v_t uuid; r jsonb;
begin
  v_p := pg_temp.project('T7 No TDS', array[118000]);
  v_m := pg_temp.ms(v_p, 1);
  v_t := pg_temp.txn(118000, date '2026-10-17', 'NEFT-R1996-NO-TDS');
  r := public.allocate_project_receipt(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m, 118000)), null, null);
  perform pg_temp.check((select status from public.project_milestones where id = v_m) = 'paid'
                        and not exists (select 1 from public.project_payments where project_id = v_p and method = 'tds')
                        and not exists (select 1 from public.tds_receivable where invoice_id = pg_temp.inv_of(v_m))
                        and (r->>'total')::int = 118000,
    'c7: old 5-argument call books ₹1,18,000 with no TDS row');
end $$;

do $$ begin raise notice 'PASS allocate_project_receipt_tds_r1996'; end $$;
rollback;
