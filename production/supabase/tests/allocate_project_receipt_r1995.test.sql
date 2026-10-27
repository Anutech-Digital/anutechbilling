-- R-1995 (27 Oct 2026, G-RECON) — ONE bank receipt shared across MANY project instalments, in one
-- transaction: public.allocate_project_receipt(bank line, project, [{milestone_id, amount,
-- raise_invoice}], received_at, reference).
-- Source: R-1910 audit cases 2, 3 and 4 (drafts/R-1910/c2_two_instalments.sql, c3_part_payment.sql,
-- c4_extra_amount.sql).
--
-- Owner's path (UI comes with R-1998): Banking → ₹2,36,000 money-in line → Reconcile → Project
-- payment → tick kist 1 and kist 2 → Save.
--
--   1. c2: ₹2,36,000 → kist 1 ₹1,18,000 + kist 2 ₹1,18,000 — both Paid, both invoices Paid with
--      paid_amount = ₹1,18,000, both payments carry the line and its date, the line is reconciled
--      (project → the first payment), GL: invoiced = money received, nothing in Undeposited funds.
--   2. c3 A: ₹59,000 on a ₹1,18,000 kist with the invoice ticked → the kist is split, the invoice is
--      for ₹59,000 and Paid, ₹59,000 is still due on the rest.
--   3. c3 B: ₹50,000 (no invoice) then ₹30,000 (invoice ticked) on one kist → the invoice is for the
--      whole kist with paid_amount ₹80,000 and ₹38,000 outstanding — not ₹1,18,000.
--   4. Refused, nothing written: the instalments add up to MORE than the line; LESS than the line
--      (c4 — extra money is an advance, R-1997); one kist given more than its balance; the same kist
--      twice; a kist of another project; a line already reconciled; another company's line; a
--      money-out line; a sales user (role gate).
--   5. All or nothing: kist 1 is written, kist 2's invoice then fails (company has no GSTIN) → no
--      payment, no split, the line stays unreconciled.
-- Fails before 20261027000541_r1995_allocate_project_receipt (the function does not exist).
begin;

create function pg_temp.r1995_fill_supplier() returns trigger language plpgsql as $r$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, Delhi');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $r$;
create trigger zz_r1995_supplier before insert on public.tenants
  for each row execute function pg_temp.r1995_fill_supplier();

insert into public.tenants (id, name, email, state_code) values
  ('f1995000-0000-4000-8000-000000000001', 'R1995 TEST CO', 'r1995@test.invalid', '07'),
  ('f1995000-0000-4000-8000-000000000002', 'R1995 OTHER CO', 'r1995-b@test.invalid', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('f1995000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1995-owner@test.invalid'),
  ('f1995000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1995-sales@test.invalid');
insert into public.users (id, tenant_id, email, role) values
  ('f1995000-0000-4000-8000-0000000000a1', 'f1995000-0000-4000-8000-000000000001', 'r1995-owner@test.invalid', 'owner'),
  ('f1995000-0000-4000-8000-0000000000a2', 'f1995000-0000-4000-8000-000000000001', 'r1995-sales@test.invalid', 'sales');
insert into public.customers (id, tenant_id, name, state_code) values
  ('f1995000-0000-4000-8000-0000000000c1', 'f1995000-0000-4000-8000-000000000001', 'R1995 Demo Client', '07');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('f1995000-0000-4000-8000-0000000000b1', 'f1995000-0000-4000-8000-000000000001', 'R1995 HDFC', 'HDFC', 0, '2026-04-01'),
  ('f1995000-0000-4000-8000-0000000000b2', 'f1995000-0000-4000-8000-000000000002', 'R1995 OTHER HDFC', 'HDFC', 0, '2026-04-01');

create function pg_temp.as_user(p_user text) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$f$;
select pg_temp.as_user('f1995000-0000-4000-8000-0000000000a1');

create temp table ids (k text primary key, v text);

create function pg_temp.txn(p_amount int, p_date date, p_desc text, p_out boolean default false,
                            p_account uuid default 'f1995000-0000-4000-8000-0000000000b1') returns uuid language sql as $f$
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source)
  select a.tenant_id, a.id, p_date, p_desc, 'UTR' || substr(md5(p_desc || p_amount), 1, 10),
         case when p_out then p_amount else 0 end, case when p_out then 0 else p_amount end, 'manual'
    from public.bank_accounts a where a.id = p_account
  returning id;
$f$;

-- A project sold the normal way (quotation → accepted) with GST-inclusive milestones.
create function pg_temp.project(p_title text, p_ms int[]) returns uuid language plpgsql as $f$
declare v_pid uuid; v_ms jsonb := '[]'; v_total int := 0; i int;
begin
  for i in 1 .. array_length(p_ms, 1) loop
    v_ms := v_ms || jsonb_build_array(jsonb_build_object('label', 'Kist ' || i, 'total_amount', p_ms[i],
                                                         'due_date', (date '2026-10-01' + (i - 1) * 30)));
    v_total := v_total + p_ms[i];
  end loop;
  v_pid := public.create_project_quote('f1995000-0000-4000-8000-0000000000c1', 'R1995 Demo Client',
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

create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $f$
begin
  if not coalesce(p_ok, false) then raise exception 'R-1995 FAIL: %', p_msg; end if;
  raise notice 'ok  : %', p_msg;
end $f$;

-- Must be refused; the message must contain p_word (the next step). Nothing may be written: the
-- line stays unreconciled and no project payment carries it.
create function pg_temp.must_refuse(p_sql text, p_what text, p_word text, p_line uuid) returns void language plpgsql as $f$
declare v_msg text; v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    if v_msg not ilike '%' || p_word || '%' then
      raise exception 'R-1995 FAIL: % — refused, but the message does not say "%": %', p_what, p_word, v_msg;
    end if;
    if p_line is not null and (exists (select 1 from public.project_payments where bank_txn_id = p_line)
       or (select matched_to_type from public.bank_transactions where id = p_line) is distinct from
          (select v from ids where k = 'matched:' || p_line::text)) then
      raise exception 'R-1995 FAIL: % — refused, but something was written on the line', p_what;
    end if;
    raise notice 'ok  : % (refused % : %)', p_what, v_state, v_msg;
    return;
  end;
  raise exception 'R-1995 FAIL: % — it was ACCEPTED', p_what;
end $f$;

-- ── 1. c2: one receipt, two instalments ─────────────────────────────────────────────────────
do $$
declare v_p uuid; v_m1 uuid; v_m2 uuid; v_t uuid; r jsonb; i1 record; i2 record; t record;
        b record; v_first uuid;
begin
  v_p  := pg_temp.project('C2 App build', array[118000, 118000]);
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2);
  v_t  := pg_temp.txn(236000, date '2026-10-07', 'RTGS-ICIC0002-R1995 DEMO CLIENT-KIST 1+2');

  r := public.allocate_project_receipt(v_t, v_p,
         pg_temp.alloc(pg_temp.a(v_m1, 118000), pg_temp.a(v_m2, 118000)), null, null);

  perform pg_temp.check(pg_temp.ms_paid(v_m1) = 118000, format('c2: kist 1 got ₹1,18,000 (got %s)', pg_temp.ms_paid(v_m1)));
  perform pg_temp.check(pg_temp.ms_paid(v_m2) = 118000, format('c2: kist 2 got ₹1,18,000 (got %s)', pg_temp.ms_paid(v_m2)));
  perform pg_temp.check((select bool_and(status = 'paid') from public.project_milestones where id in (v_m1, v_m2)),
    'c2: kist 1 and kist 2 both Paid on the project page');
  select * into i1 from public.invoices where id = (select invoice_id from public.project_milestones where id = v_m1);
  select * into i2 from public.invoices where id = (select invoice_id from public.project_milestones where id = v_m2);
  perform pg_temp.check(i1.amount = 118000 and i1.status::text = 'paid' and i1.paid_amount = 118000,
    format('c2: kist 1 invoice ₹1,18,000 Paid, paid_amount ₹1,18,000 (got %s %s %s)', i1.amount, i1.status, i1.paid_amount));
  perform pg_temp.check(i2.amount = 118000 and i2.status::text = 'paid' and i2.paid_amount = 118000,
    format('c2: kist 2 invoice ₹1,18,000 Paid, paid_amount ₹1,18,000 (got %s %s %s)', i2.amount, i2.status, i2.paid_amount));
  perform pg_temp.check(i1.paid_date = date '2026-10-07' and i2.paid_date = date '2026-10-07', 'c2: invoices paid on the bank date');
  perform pg_temp.check((select count(*) = 2 and bool_and(bank_txn_id = v_t) and bool_and(received_at = date '2026-10-07')
                           and bool_and(reference is not null)
                           from public.project_payments where project_id = v_p),
    'c2: two payments, both on this bank line, dated the bank day, with the UTR');
  select * into t from public.bank_transactions where id = v_t;
  v_first := (r->'allocations'->0->>'payment_id')::uuid;
  perform pg_temp.check(t.matched_to_type = 'project' and t.matched_to_id = v_first::text
                        and (select milestone_id from public.project_payments where id = v_first) = v_m1,
    'c2: the bank line is reconciled once, to the first (kist 1) payment');
  perform pg_temp.check((r->>'total')::int = 236000 and jsonb_array_length(r->'allocations') = 2, 'c2: result lists both allocations');

  -- GL: ₹2,36,000 in the bank = ₹2,36,000 invoiced and paid; nothing left in Undeposited funds.
  select undeposited_funds, project_receivable into b from public.report_balance_sheet(public.ist_today());
  perform pg_temp.check((select sum(amount) from public.invoices where id in (i1.id, i2.id)) = 236000,
    'c2 GL: invoiced = money received ₹2,36,000');
  perform pg_temp.check(b.undeposited_funds = 0, format('c2 GL: nothing in Undeposited funds (got %s)', b.undeposited_funds));
  perform pg_temp.check(b.project_receivable = 0, format('c2 GL: project receivable 0 (got %s)', b.project_receivable));
  insert into ids values ('c2_line', v_t::text), ('matched:' || v_t::text, 'project');
end $$;

-- ── 2. c3 A: part of a kist, invoice ticked → split, invoice for the money received ─────────
do $$
declare v_p uuid; v_m uuid; v_t uuid; r jsonb; v_part uuid; i record;
begin
  v_p := pg_temp.project('C3A Website', array[118000]);
  v_m := pg_temp.ms(v_p, 1);
  v_t := pg_temp.txn(59000, date '2026-10-08', 'UPI-R1995 DEMO CLIENT-HALF');
  r := public.allocate_project_receipt(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m, 59000)), null, 'UPI half');
  v_part := (r->'allocations'->0->>'milestone_id')::uuid;
  perform pg_temp.check(v_part is distinct from v_m and (r->'allocations'->0->>'from_milestone_id')::uuid = v_m,
    'c3 A: the part was carved out of kist 1 (split)');
  select * into i from public.invoices where id = (r->'allocations'->0->>'invoice_id');
  perform pg_temp.check(i.amount = 59000 and i.status::text = 'paid' and i.paid_amount = 59000,
    format('c3 A: invoice only for the ₹59,000 received, Paid (got %s %s %s)', i.amount, i.status, i.paid_amount));
  perform pg_temp.check((select total_amount from public.project_milestones where id = v_m) = 59000 and pg_temp.ms_paid(v_m) = 0
                        and (select invoice_id from public.project_milestones where id = v_m) is null,
    'c3 A: ₹59,000 still due on the rest of kist 1, not invoiced');
  perform pg_temp.check((select total_amount from public.project_sales where id = v_p) = 118000, 'c3 A: project value unchanged');
end $$;

-- ── 3. c3 B: two parts, invoice ticked only on the second → paid_amount from both parts ──────
do $$
declare v_p uuid; v_m uuid; t1 uuid; t2 uuid; r jsonb; i record;
begin
  v_p := pg_temp.project('C3B Mobile app', array[118000]);
  v_m := pg_temp.ms(v_p, 1);
  t1  := pg_temp.txn(50000, date '2026-10-09', 'NEFT-R1995 DEMO CLIENT-PART1');
  t2  := pg_temp.txn(30000, date '2026-10-15', 'NEFT-R1995 DEMO CLIENT-PART2');
  perform public.allocate_project_receipt(t1, v_p, pg_temp.alloc(pg_temp.a(v_m, 50000, false)), null, null);
  perform pg_temp.check((select invoice_id from public.project_milestones where id = v_m) is null
                        and (select matched_to_type from public.bank_transactions where id = t1) = 'project',
    'c3 B: part 1 booked and reconciled, no invoice');
  r := public.allocate_project_receipt(t2, v_p, pg_temp.alloc(pg_temp.a(v_m, 30000, true)), null, null);
  select * into i from public.invoices where id = (r->'allocations'->0->>'invoice_id');
  perform pg_temp.check(pg_temp.ms_paid(v_m) = 80000, 'c3 B: project page shows ₹80,000 received');
  perform pg_temp.check(i.amount = 118000 and i.paid_amount = 80000 and i.status::text = 'pending',
    format('c3 B: invoice %s for the kist, paid_amount ₹80,000, still pending (got %s %s %s)', i.id, i.amount, i.paid_amount, i.status));
  perform pg_temp.check(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0)) = 38000,
    format('c3 B: Aging / Invoices Outstanding say ₹38,000 due (they say %s)',
           greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))));
  insert into ids values ('c3b_ms', v_m::text), ('c3b_p', v_p::text);
end $$;

-- ── 4. refusals — nothing written ──────────────────────────────────────────────────────────
do $$
declare v_p uuid; v_q uuid; v_m1 uuid; v_m2 uuid; v_other uuid;
begin
  v_p  := pg_temp.project('C4 CRM', array[118000, 118000]);
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2);
  v_q  := pg_temp.project('C4 other project', array[50000]);
  v_other := pg_temp.ms(v_q, 1);
  insert into ids values ('c4_p', v_p::text), ('c4_m1', v_m1::text), ('c4_m2', v_m2::text), ('c4_q', v_other::text),
    ('line_118', pg_temp.txn(118000, date '2026-10-10', 'IMPS-R1995-118000')::text),
    ('line_150', pg_temp.txn(150000, date '2026-10-10', 'IMPS-R1995-150000')::text),
    ('line_out', pg_temp.txn(118000, date '2026-10-10', 'R1995 MONEY OUT', true)::text),
    ('line_oth', pg_temp.txn(118000, date '2026-10-10', 'R1995 OTHER CO LINE', false, 'f1995000-0000-4000-8000-0000000000b2')::text);
end $$;

select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000), pg_temp.a(%L, 118000)))$q$,
  (select v from ids where k = 'line_118'), (select v from ids where k = 'c4_p'), (select v from ids where k = 'c4_m1'), (select v from ids where k = 'c4_m2')),
  'total ₹2,36,000 on a ₹1,18,000 line', 'more than this bank line', (select v::uuid from ids where k = 'line_118'));

select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000)))$q$,
  (select v from ids where k = 'line_150'), (select v from ids where k = 'c4_p'), (select v from ids where k = 'c4_m1')),
  'c4: ₹1,50,000 line, only ₹1,18,000 on instalments (extra → advance is R-1997)', 'not on any instalment', (select v::uuid from ids where k = 'line_150'));

select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, pg_temp.alloc(pg_temp.a(%L, 150000)))$q$,
  (select v from ids where k = 'line_150'), (select v from ids where k = 'c4_p'), (select v from ids where k = 'c4_m1')),
  'c4: ₹1,50,000 on kist 1 of ₹1,18,000', 'only ₹118000 left', (select v::uuid from ids where k = 'line_150'));

select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, pg_temp.alloc(pg_temp.a(%L, 59000), pg_temp.a(%L, 59000)))$q$,
  (select v from ids where k = 'line_118'), (select v from ids where k = 'c4_p'), (select v from ids where k = 'c4_m1'), (select v from ids where k = 'c4_m1')),
  'the same kist twice', 'ticked twice', (select v::uuid from ids where k = 'line_118'));

select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, pg_temp.alloc(pg_temp.a(%L, 68000), pg_temp.a(%L, 50000)))$q$,
  (select v from ids where k = 'line_118'), (select v from ids where k = 'c4_p'), (select v from ids where k = 'c4_m1'), (select v from ids where k = 'c4_q')),
  'a kist of another project', 'does not belong', (select v::uuid from ids where k = 'line_118'));

select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000)))$q$,
  (select v from ids where k = 'c2_line'), (select v from ids where k = 'c4_p'), (select v from ids where k = 'c4_m1')),
  'a line already reconciled (c2 line again)', 'already reconciled', null);

select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000)))$q$,
  (select v from ids where k = 'line_oth'), (select v from ids where k = 'c4_p'), (select v from ids where k = 'c4_m1')),
  'another company''s line', 'not found in your company', (select v::uuid from ids where k = 'line_oth'));

select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000)))$q$,
  (select v from ids where k = 'line_out'), (select v from ids where k = 'c4_p'), (select v from ids where k = 'c4_m1')),
  'a money-out line', 'money out', (select v::uuid from ids where k = 'line_out'));

select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, '[]'::jsonb)$q$,
  (select v from ids where k = 'line_118'), (select v from ids where k = 'c4_p')),
  'no instalment ticked', 'at least one instalment', (select v::uuid from ids where k = 'line_118'));

select pg_temp.as_user('f1995000-0000-4000-8000-0000000000a2');
select pg_temp.must_refuse(format($q$select public.allocate_project_receipt(%L, %L, pg_temp.alloc(pg_temp.a(%L, 118000)))$q$,
  (select v from ids where k = 'line_118'), (select v from ids where k = 'c4_p'), (select v from ids where k = 'c4_m1')),
  'a sales user (role gate)', 'Only an owner', (select v::uuid from ids where k = 'line_118'));
select pg_temp.as_user('f1995000-0000-4000-8000-0000000000a1');

do $$ begin
  perform pg_temp.check((select count(*) from public.project_payments where project_id = (select v::uuid from ids where k = 'c4_p')) = 0
                        and (select count(*) from public.project_milestones where project_id = (select v::uuid from ids where k = 'c4_p')) = 2,
    'refusals: C4 project untouched (no payment, no split)');
end $$;

-- ── 5. all or nothing: kist 2's invoice fails after kist 1 is written ──────────────────────
do $$
declare v_p uuid; v_m1 uuid; v_m2 uuid; v_t uuid; v_msg text;
begin
  v_p  := pg_temp.project('C5 Atomic', array[118000, 118000]);
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2);
  v_t  := pg_temp.txn(177000, date '2026-10-11', 'NEFT-R1995-ATOMIC');
  update public.tenants set gstin = null where id = 'f1995000-0000-4000-8000-000000000001';
  begin
    -- kist 1 in full without invoice, then half of kist 2 WITH invoice → split, pay, invoice refused
    perform public.allocate_project_receipt(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m1, 118000, false), pg_temp.a(v_m2, 59000, true)));
    raise exception 'R-1995 FAIL: atomic — the call went through without a company GSTIN';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'R-1995 FAIL%' then raise; end if;
    raise notice 'ok  : atomic — refused mid-way (%)', v_msg;
  end;
  perform pg_temp.check((select count(*) from public.project_payments where project_id = v_p) = 0, 'atomic: no payment left behind');
  perform pg_temp.check((select count(*) from public.project_milestones where project_id = v_p) = 2
                        and (select total_amount from public.project_milestones where id = v_m2) = 118000, 'atomic: no split left behind');
  perform pg_temp.check((select matched_to_type from public.bank_transactions where id = v_t) is null, 'atomic: the line is still unreconciled');
end $$;

do $$ begin raise notice 'PASS allocate_project_receipt_r1995'; end $$;
rollback;
