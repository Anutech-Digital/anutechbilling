-- R-1993 (26 Oct 2026, G-RECON) — a project receipt cannot book a bank line twice, nor more than the line.
-- Source: R-1910 audit case 1, break-mode B1/B2 (drafts/R-1910/c1_full_instalment.sql).
--
-- Owner's path: Banking → money-in line → Reconcile → "Project payment" → pick project/milestone →
-- "Record project payment & reconcile" = record_project_payment (or record_project_receipt_with_tds
-- when TDS is ticked), then raise_project_milestone_invoice.
--
--   0. Normal path still works: ₹1,18,000 line pays kist 1 in full, kist 1 Paid, invoice born paid,
--      line reconciled to that payment.
--   1. B1: the SAME line on a second milestone (double click / second tab / another user) is refused,
--      the message says to un-reconcile first and the HINT links Banking. Nothing is written.
--   2. B2: ₹5,00,000 on a ₹1,18,000 line is refused (message says the line amount, hint = Banking).
--   3. Same two guards through record_project_receipt_with_tds (bank part > line; line already used).
--   4. A line freed (matched_to_type cleared) that still carries a project payment cannot take
--      more than what is left of it.
--   5. A money-out line, or another company's line, is refused.
--   6. Exactly the line amount is fine (0), and the net of a TDS receipt equal to the line is fine.
-- Fails before 20261026183034_r1993_project_payment_bank_line_guards (B1/B2 accepted).
begin;

create function pg_temp.r1993_fill_supplier() returns trigger language plpgsql as $r$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, Delhi');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $r$;
create trigger zz_r1993_supplier before insert on public.tenants
  for each row execute function pg_temp.r1993_fill_supplier();

insert into public.tenants (id, name, email, state_code) values
  ('f1993000-0000-4000-8000-000000000001', 'R1993 TEST CO', 'r1993@test.invalid', '07'),
  ('f1993000-0000-4000-8000-000000000002', 'R1993 OTHER CO', 'r1993-b@test.invalid', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('f1993000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1993-owner@test.invalid');
insert into public.users (id, tenant_id, email, role) values
  ('f1993000-0000-4000-8000-0000000000a1', 'f1993000-0000-4000-8000-000000000001', 'r1993-owner@test.invalid', 'owner');
insert into public.customers (id, tenant_id, name, state_code) values
  ('f1993000-0000-4000-8000-0000000000c1', 'f1993000-0000-4000-8000-000000000001', 'R1993 Demo Client', '07');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('f1993000-0000-4000-8000-0000000000b1', 'f1993000-0000-4000-8000-000000000001', 'R1993 HDFC', 'HDFC', 0, '2026-04-01'),
  ('f1993000-0000-4000-8000-0000000000b2', 'f1993000-0000-4000-8000-000000000002', 'R1993 OTHER HDFC', 'HDFC', 0, '2026-04-01');

select set_config('request.jwt.claims',
  json_build_object('sub', 'f1993000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);

create temp table ids (k text primary key, v text);

create function pg_temp.txn(p_amount int, p_date date, p_desc text, p_out boolean default false,
                            p_account uuid default 'f1993000-0000-4000-8000-0000000000b1') returns uuid language sql as $f$
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source)
  select a.tenant_id, a.id, p_date, p_desc, 'UTR' || substr(md5(p_desc || p_amount), 1, 10),
         case when p_out then p_amount else 0 end, case when p_out then 0 else p_amount end, 'manual'
    from public.bank_accounts a where a.id = p_account
  returning id;
$f$;

create function pg_temp.ms(p_project uuid, p_seq int) returns uuid language sql as $f$
  select id from public.project_milestones where project_id = p_project and seq = p_seq;
$f$;

-- Must be refused; the message must contain p_word (the next step) and the hint must be p_hint.
create function pg_temp.must_refuse(p_sql text, p_what text, p_word text, p_hint text) returns void language plpgsql as $f$
declare v_msg text; v_hint text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
    if v_msg not ilike '%' || p_word || '%' then
      raise exception 'R-1993 FAIL: % — refused, but the message does not say "%": %', p_what, p_word, v_msg;
    end if;
    if v_hint is distinct from p_hint then
      raise exception 'R-1993 FAIL: % — refused, but hint is % (want %)', p_what, v_hint, p_hint;
    end if;
    raise notice 'ok  : % (refused: % | hint %)', p_what, v_msg, v_hint;
    return;
  end;
  raise exception 'R-1993 FAIL: % — it was ACCEPTED', p_what;
end $f$;

-- ── 0. normal path ─────────────────────────────────────────────────────────────
do $$
declare v_p uuid; v_m1 uuid; v_m2 uuid; v_t uuid; v_pay uuid; v_inv text; i record; t record;
begin
  v_p := public.create_project_quote('f1993000-0000-4000-8000-0000000000c1', 'R1993 Demo Client', 'C1 ERP', null,
           '[{"name":"C1 ERP","qty":1,"rate":200000,"amount":200000}]'::jsonb, 18, false,
           '[{"label":"Kist 1","total_amount":118000,"due_date":"2026-10-01"},
             {"label":"Kist 2","total_amount":118000,"due_date":"2026-10-31"},
             {"label":"Kist 3","total_amount":236000,"due_date":"2026-11-30"}]'::jsonb);
  perform public.accept_project_quote(v_p);
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2);
  v_t  := pg_temp.txn(118000, date '2026-10-05', 'NEFT-HDFC0001-R1993 DEMO CLIENT-KIST1');

  v_pay := public.record_project_payment(v_m1, 118000, 'bank_transfer', 'NEFT kist 1', date '2026-10-05', v_t);
  v_inv := public.raise_project_milestone_invoice(v_m1);
  select * into i from public.invoices where id = v_inv;
  select * into t from public.bank_transactions where id = v_t;
  if (select status from public.project_milestones where id = v_m1) <> 'paid' then raise exception 'R-1993 FAIL: kist 1 not Paid'; end if;
  if i.amount <> 118000 or i.status::text <> 'paid' then raise exception 'R-1993 FAIL: invoice % %', i.amount, i.status; end if;
  if t.matched_to_type is distinct from 'project' or t.matched_to_id is distinct from v_pay::text then
    raise exception 'R-1993 FAIL: bank line not reconciled to the payment (% %)', t.matched_to_type, t.matched_to_id; end if;
  insert into ids values ('p', v_p::text), ('m2', v_m2::text), ('m3', pg_temp.ms(v_p, 3)::text), ('t', v_t::text), ('pay', v_pay::text);
  raise notice 'ok  : 0. normal path — kist 1 Paid, invoice paid, line reconciled';
end $$;

-- ── 1. B1: the same line on a second milestone ─────────────────────────────────
select pg_temp.must_refuse(format(
  $q$select public.record_project_payment(%L, 118000, 'bank_transfer', 'again', date '2026-10-05', %L)$q$,
  (select v from ids where k = 'm2'), (select v from ids where k = 't')),
  '1. B1: a reconciled bank line pays a second milestone', 'un-reconcile', '/accounting/banking');
do $$ begin
  if (select count(*) from public.project_payments where bank_txn_id = (select v from ids where k = 't')::uuid) <> 1 then
    raise exception 'R-1993 FAIL: 1. a second payment was written on the line'; end if;
  if (select matched_to_id from public.bank_transactions where id = (select v from ids where k = 't')::uuid)
     is distinct from (select v from ids where k = 'pay') then raise exception 'R-1993 FAIL: 1. the line was re-pointed'; end if;
  if (select count(*) from public.project_payments where milestone_id = (select v from ids where k = 'm2')::uuid) <> 0 then
    raise exception 'R-1993 FAIL: 1. kist 2 got a payment'; end if;
end $$;

-- ── 2. B2: more than the line ──────────────────────────────────────────────────
insert into ids select 't2', pg_temp.txn(118000, date '2026-10-06', 'UPI-R1993-B2')::text;
select pg_temp.must_refuse(format(
  $q$select public.record_project_payment(%L, 500000, 'bank_transfer', 'typo', date '2026-10-06', %L)$q$,
  (select v from ids where k = 'm2'), (select v from ids where k = 't2')),
  '2. B2: ₹5,00,000 on a ₹1,18,000 bank line', '118000', '/accounting/banking');

-- ── 3. the TDS path has the same two guards ────────────────────────────────────
select pg_temp.must_refuse(format(
  $q$select public.record_project_receipt_with_tds(%L, 200000, 4000, '194J', 2, 200000, date '2026-10-06', %L, 'tds big', false)$q$,
  (select v from ids where k = 'm3'), (select v from ids where k = 't2')),
  '3a. TDS receipt: bank part bigger than the line', '118000', '/accounting/banking');
select pg_temp.must_refuse(format(
  $q$select public.record_project_receipt_with_tds(%L, 116000, 2000, '194J', 2, 100000, date '2026-10-05', %L, 'tds again', false)$q$,
  (select v from ids where k = 'm2'), (select v from ids where k = 't')),
  '3b. TDS receipt on a reconciled line', 'un-reconcile', '/accounting/banking');
do $$ begin
  if exists (select 1 from public.project_payments
              where milestone_id in ((select v from ids where k = 'm2')::uuid, (select v from ids where k = 'm3')::uuid)) then
    raise exception 'R-1993 FAIL: 3. a refused TDS receipt left a payment behind'; end if;
  if exists (select 1 from public.tds_receivable where tenant_id = 'f1993000-0000-4000-8000-000000000001') then
    raise exception 'R-1993 FAIL: 3. a refused TDS receipt left a TDS row behind'; end if;
end $$;

-- ── 4. a freed line that still carries a project payment ───────────────────────
update public.bank_transactions set matched_to_type = null, matched_to_id = null
 where id = (select v from ids where k = 't')::uuid;
select pg_temp.must_refuse(format(
  $q$select public.record_project_payment(%L, 1000, 'bank_transfer', 'leftover', date '2026-10-05', %L)$q$,
  (select v from ids where k = 'm2'), (select v from ids where k = 't')),
  '4. a freed line already fully used by a project payment', '118000', '/accounting/banking');

-- ── 5. a money-out line, another company's line ────────────────────────────────
select pg_temp.must_refuse(format(
  $q$select public.record_project_payment(%L, 1000, 'bank_transfer', 'out', date '2026-10-06', %L)$q$,
  (select v from ids where k = 'm2'), pg_temp.txn(1000, date '2026-10-06', 'NEFT OUT R1993', true)),
  '5a. a money-out bank line', 'money-in', '/accounting/banking');
select pg_temp.must_refuse(format(
  $q$select public.record_project_payment(%L, 1000, 'bank_transfer', 'other co', date '2026-10-06', %L)$q$,
  (select v from ids where k = 'm2'),
  pg_temp.txn(1000, date '2026-10-06', 'NEFT R1993 OTHER CO', false, 'f1993000-0000-4000-8000-0000000000b2')),
  '5b. another company''s bank line', 'pick', '/accounting/banking');

-- ── 6. exactly the line amount, and a TDS receipt whose net = the line ─────────
do $$
declare r jsonb; v_m2 uuid := (select v from ids where k = 'm2')::uuid; v_m3 uuid := (select v from ids where k = 'm3')::uuid;
        v_t2 uuid := (select v from ids where k = 't2')::uuid; v_t3 uuid;
begin
  perform public.record_project_payment(v_m2, 118000, 'bank_transfer', 'kist 2', date '2026-10-06', v_t2);
  if (select status from public.project_milestones where id = v_m2) <> 'paid' then raise exception 'R-1993 FAIL: 6. kist 2 not Paid'; end if;
  v_t3 := pg_temp.txn(231280, date '2026-10-07', 'NEFT-R1993-KIST3-NET');
  r := public.record_project_receipt_with_tds(v_m3, 231280, 4720, '194J', 2, 236000, date '2026-10-07', v_t3, 'kist 3', false);
  if (select matched_to_id from public.bank_transactions where id = v_t3) is distinct from r->>'net_payment' then
    raise exception 'R-1993 FAIL: 6. TDS receipt line not reconciled to its net payment'; end if;
  if (select status from public.project_milestones where id = v_m3) <> 'paid' then raise exception 'R-1993 FAIL: 6. kist 3 not Paid'; end if;
  raise notice 'ok  : 6. exact line amount and TDS net = line both book';
end $$;

do $$ begin raise notice 'R-1993: PASS'; end $$;
rollback;
