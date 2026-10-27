\set ON_ERROR_STOP on
-- R-1992 (P1, G-RECON): report_balance_sheet — project TDS is not Undeposited funds, and project
-- money received beyond the invoiced milestones is an advance from the customer (liability).
-- Migration: 20261026235600_r1992_balance_sheet_project_tds_advance.sql (on R-1952's body).
-- Red proofs it turns green: R-1910 audit c5 (GL check), c6 Path B, c2/c4 GL checks.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/balance_sheet_project_tds_advance_r1992.test.sql
--
-- Expect "PASS balance_sheet_project_tds_advance_r1992". Every check is collected; failures listed together.
-- The owner's real path: projects sold through create_project_quote + accept_project_quote, money
-- booked through record_project_payment / record_project_receipt_with_tds (what the Reconcile
-- dialog's "Project payment" calls), invoices through raise_project_milestone_invoice.
--
--   TDS    ₹5,90,000 kist paid ₹5,40,000 + ₹50,000 TDS (194J 10%); ₹1,18,000 kist paid ₹1,16,000 +
--          ₹2,000 TDS (194C 2%) → bank ₹6,56,000, TDS receivable ₹52,000, Undeposited funds 0
--          (was ₹52,000: the TDS counted twice).
--   ADV    "New project" ₹2,00,000 advance, invoice unticked → advances from customers +₹2,00,000
--          (was 0: bank up, nothing on the other side). Invoice raised later → the advance is gone,
--          nothing receivable.
--   EXTRA  ₹1,50,000 booked on a ₹1,18,000 kist, invoice raised → ₹32,000 advance (c4).
--   TWO    ₹2,36,000 on kist 1 of 2 × ₹1,18,000, kist 1 invoiced → ₹1,18,000 advance (c2).
--   PART   ₹50,000 on an invoiced ₹1,18,000 kist → project receivable ₹68,000, no advance (unchanged).
--   CASH   ₹10,000 cash project receipt with no bank line → still Undeposited funds (unchanged).
--   BAL    every step: Δ(bank + undeposited + project receivable + TDS receivable) − Δ(advances)
--          = Δ(project invoices raised) — the money side matches the books' sales side.

begin;
select set_config('request.jwt.claims', '', true);

-- Issuing a Tax Invoice needs the company's own GSTIN + address (R-1643/R-1803).
create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, Delhi');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $r$;
create trigger zz_r1992_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

insert into public.tenants (id, name, email, state_code)
values ('e1992000-0000-4000-8000-000000000001', 'R1992 TEST CO', 'r1992@test.invalid', '07');
insert into auth.users (id, instance_id, aud, role, email)
values ('e1992000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'r1992-owner@test.invalid');
insert into public.users (id, tenant_id, email, role)
values ('e1992000-0000-4000-8000-0000000000a1', 'e1992000-0000-4000-8000-000000000001',
        'r1992-owner@test.invalid', 'owner');
insert into public.customers (id, tenant_id, name, state_code)
values ('e1992000-0000-4000-8000-0000000000c1', 'e1992000-0000-4000-8000-000000000001', 'R1992 Demo Client', '07'),
       ('e1992000-0000-4000-8000-0000000000c2', 'e1992000-0000-4000-8000-000000000001', 'R1992 Other Client', '07');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date)
values ('e1992000-0000-4000-8000-0000000000b1', 'e1992000-0000-4000-8000-000000000001', 'R1992 HDFC', 'HDFC', 0, '2026-04-01');

select set_config('request.jwt.claims',
  json_build_object('sub', 'e1992000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);

create temp table fails (n serial, msg text);

create function pg_temp.txn(p_amount int, p_date date, p_desc text) returns uuid language sql as $f$
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source)
  values ('e1992000-0000-4000-8000-000000000001', 'e1992000-0000-4000-8000-0000000000b1', p_date, p_desc,
          'UTR' || substr(md5(p_desc || p_amount), 1, 10), 0, p_amount, 'manual')
  returning id;
$f$;

-- A project sold the normal way (quotation → accepted) with GST-inclusive milestones.
create function pg_temp.project(p_title text, p_ms int[], p_customer uuid default 'e1992000-0000-4000-8000-0000000000c1')
returns uuid language plpgsql as $f$
declare v_pid uuid; v_ms jsonb := '[]'; v_total int := 0; i int;
begin
  for i in 1 .. array_length(p_ms, 1) loop
    v_ms := v_ms || jsonb_build_array(jsonb_build_object('label', 'Kist ' || i, 'total_amount', p_ms[i],
                                                         'due_date', (date '2026-10-01' + (i - 1) * 30)));
    v_total := v_total + p_ms[i];
  end loop;
  v_pid := public.create_project_quote(p_customer, (select name from public.customers where id = p_customer),
             p_title, null, jsonb_build_array(jsonb_build_object('name', p_title, 'qty', 1,
             'rate', round(v_total * 100.0 / 118), 'amount', round(v_total * 100.0 / 118))),
             18, false, v_ms);
  perform public.accept_project_quote(v_pid);
  return v_pid;
end $f$;

create function pg_temp.ms(p_project uuid, p_seq int) returns uuid language sql as $f$
  select id from public.project_milestones where project_id = p_project and seq = p_seq;
$f$;

-- The Balance Sheet lines this test reads + the project invoices raised so far (sales side).
create temp table snap (k text primary key, cash bigint, undeposited bigint, advances bigint,
                        project_receivable bigint, tds bigint, invoiced bigint);
create function pg_temp.snap(p_k text) returns void language sql as $f$
  insert into snap
  select p_k, b.cash_and_bank, b.undeposited_funds, b.advances_from_customers, b.project_receivable, b.tds_receivable,
         (select coalesce(sum(i.amount), 0) from public.invoices i
           where i.tenant_id = 'e1992000-0000-4000-8000-000000000001'
             and exists (select 1 from public.project_milestones pm where pm.invoice_id = i.id))
    from public.report_balance_sheet(public.ist_today()) b;
$f$;

create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $f$
begin
  if not coalesce(p_ok, false) then insert into fails (msg) values (p_msg); end if;
end $f$;

-- Δ between two snapshots: one line per field, and the balance identity.
create function pg_temp.delta(p_case text, a text, b text, d_cash bigint, d_undep bigint, d_adv bigint,
                              d_prec bigint, d_tds bigint) returns void language plpgsql as $f$
declare x snap; y snap;
begin
  select * into x from snap where k = a; select * into y from snap where k = b;
  perform pg_temp.check(y.cash - x.cash = d_cash, format('%s: bank Δ %s (got %s)', p_case, d_cash, y.cash - x.cash));
  perform pg_temp.check(y.undeposited - x.undeposited = d_undep, format('%s: Undeposited funds Δ %s (got %s)', p_case, d_undep, y.undeposited - x.undeposited));
  perform pg_temp.check(y.advances - x.advances = d_adv, format('%s: advances from customers Δ %s (got %s)', p_case, d_adv, y.advances - x.advances));
  perform pg_temp.check(y.project_receivable - x.project_receivable = d_prec, format('%s: project receivable Δ %s (got %s)', p_case, d_prec, y.project_receivable - x.project_receivable));
  perform pg_temp.check(y.tds - x.tds = d_tds, format('%s: TDS receivable Δ %s (got %s)', p_case, d_tds, y.tds - x.tds));
  perform pg_temp.check(
    (y.cash - x.cash) + (y.undeposited - x.undeposited) + (y.project_receivable - x.project_receivable) + (y.tds - x.tds)
      - (y.advances - x.advances) = (y.invoiced - x.invoiced),
    format('%s: BAL — assets − advances moved %s, project invoices moved %s', p_case,
           (y.cash - x.cash) + (y.undeposited - x.undeposited) + (y.project_receivable - x.project_receivable) + (y.tds - x.tds)
             - (y.advances - x.advances), y.invoiced - x.invoiced));
end $f$;

do $$
declare v_p uuid; v_m uuid; v_t uuid; r jsonb;
begin
  perform pg_temp.snap('s0');

  -- TDS (c5): 10% and 2%, both kists fully settled, invoices raised in the same RPC
  v_p := pg_temp.project('R1992 ERP', array[590000]);
  v_t := pg_temp.txn(540000, date '2026-10-12', 'NEFT-R1992 DEMO CLIENT-ERP LESS TDS');
  r := public.record_project_receipt_with_tds(pg_temp.ms(v_p, 1), 540000, 50000, '194J', 10, 500000, date '2026-10-12', v_t, 'NEFT less TDS', true);
  v_p := pg_temp.project('R1992 Support contract', array[118000]);
  v_t := pg_temp.txn(116000, date '2026-10-13', 'UPI-R1992 DEMO CLIENT-SUPPORT');
  r := public.record_project_receipt_with_tds(pg_temp.ms(v_p, 1), 116000, 2000, '194C', 2, 100000, date '2026-10-13', v_t, 'UPI less TDS', true);
  perform pg_temp.snap('s1');
  perform pg_temp.delta('TDS', 's0', 's1', 656000, 0, 0, 0, 52000);

  -- ADV (c6 Path B): "Project payment → New project", advance with the invoice box unticked
  v_t := pg_temp.txn(200000, date '2026-10-03', 'RTGS-R1992 OTHER CLIENT-ADVANCE');
  v_p := public.create_project_quote('e1992000-0000-4000-8000-0000000000c2', 'R1992 Other Client', 'R1992 Data migration', null,
           '[{"name":"R1992 Data migration","qty":1,"rate":500000,"amount":500000}]'::jsonb, 18, false,
           '[{"label":"Advance","total_amount":200000,"due_date":null},{"label":"Balance","total_amount":390000,"due_date":null}]'::jsonb);
  perform public.accept_project_quote(v_p);
  v_m := pg_temp.ms(v_p, 1);
  perform public.record_project_payment(v_m, 200000, 'bank_transfer', 'RTGS advance', date '2026-10-03', v_t);
  perform pg_temp.snap('s2');
  perform pg_temp.delta('ADV', 's1', 's2', 200000, 0, 200000, 0, 0);
  -- the advance kist is invoiced later → no longer an advance, nothing receivable on it
  perform public.raise_project_milestone_invoice(v_m);
  perform pg_temp.snap('s3');
  perform pg_temp.delta('ADV invoiced', 's2', 's3', 0, 0, -200000, 0, 0);

  -- EXTRA (c4): ₹1,50,000 against kist 1 of ₹1,18,000, invoice raised → ₹32,000 advance
  v_p := pg_temp.project('R1992 CRM', array[118000, 118000]);
  v_t := pg_temp.txn(150000, date '2026-10-10', 'IMPS-R1992 DEMO CLIENT-150000');
  perform public.record_project_payment(pg_temp.ms(v_p, 1), 150000, 'bank_transfer', 'IMPS 1.5L', date '2026-10-10', v_t);
  perform public.raise_project_milestone_invoice(pg_temp.ms(v_p, 1));
  perform pg_temp.snap('s4');
  perform pg_temp.delta('EXTRA', 's3', 's4', 150000, 0, 32000, 0, 0);

  -- TWO (c2): ₹2,36,000 for kist 1 + 2 booked on kist 1, kist 1 invoiced → ₹1,18,000 advance
  v_p := pg_temp.project('R1992 App build', array[118000, 118000]);
  v_t := pg_temp.txn(236000, date '2026-10-07', 'RTGS-R1992 DEMO CLIENT-KIST 1+2');
  perform public.record_project_payment(pg_temp.ms(v_p, 1), 236000, 'bank_transfer', 'RTGS kist 1+2', date '2026-10-07', v_t);
  perform public.raise_project_milestone_invoice(pg_temp.ms(v_p, 1));
  perform pg_temp.snap('s5');
  perform pg_temp.delta('TWO', 's4', 's5', 236000, 0, 118000, 0, 0);

  -- PART: ₹50,000 on an invoiced ₹1,18,000 kist → ₹68,000 receivable (unchanged behaviour)
  v_p := pg_temp.project('R1992 Website', array[118000]);
  perform public.raise_project_milestone_invoice(pg_temp.ms(v_p, 1));
  v_t := pg_temp.txn(50000, date '2026-10-14', 'UPI-R1992 DEMO CLIENT-PART');
  perform public.record_project_payment(pg_temp.ms(v_p, 1), 50000, 'bank_transfer', 'UPI part', date '2026-10-14', v_t);
  perform pg_temp.snap('s6');
  perform pg_temp.delta('PART', 's5', 's6', 50000, 0, 0, 68000, 0);

  -- CASH: a cash project receipt (no bank line) is still cash in hand — only TDS is left out
  perform public.record_project_payment(pg_temp.ms(v_p, 1), 10000, 'cash', 'cash at office', date '2026-10-15', null);
  perform pg_temp.snap('s7');
  perform pg_temp.delta('CASH', 's6', 's7', 0, 10000, 0, -10000, 0);
end $$;

do $$
declare v text;
begin
  select string_agg(n || '. ' || msg, E'\n' order by n) into v from fails;
  if v is not null then raise exception E'FAIL balance_sheet_project_tds_advance_r1992\n%', v; end if;
  raise notice 'PASS balance_sheet_project_tds_advance_r1992';
end $$;

rollback;
