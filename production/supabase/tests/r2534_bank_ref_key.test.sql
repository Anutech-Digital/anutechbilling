\set ON_ERROR_STOP on
-- R-2534 (P1 money, G-RECON): the bank's own reference (UTR / RRN / cheque no.) is read out of the
-- narration into bank_transactions.ref_key, and a receipt carrying it ranks 'exact'.
-- Migration: 20261106133216_r2534_bank_ref_key.sql
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2534_bank_ref_key.test.sql
--
-- Expect "PASS r2534_bank_ref_key". Every check is collected and failures listed together.
--
--   PARSE    the same table as src/lib/banking/narration-ref-cases.ts (narration-ref.test.ts proves
--            every row of it is below) → normalize_bank_ref gives the same key as the TS twin.
--   FILL     a new line gets its ref_key on insert; editing the narration recomputes it.
--   BACKFILL the migration's backfill statement fills old lines from their own text only (two
--            companies), and a second run writes 0 rows.
--   MATCH    an NEFT ₹5,000 line with UTR HDFCN52026110612345: P1 (15 days later, reference = the
--            UTR) is first and 'exact'; P2 (same day, same amount, no reference) is only 'high';
--            company B's receipt with the same UTR is never offered; auto-reconcile books P1. Two
--            receipts with the same UTR → both 'exact' → auto-reconcile books neither (fail closed).

begin;
select set_config('request.jwt.claims', '', true);

create temp table r2534_fail (msg text) on commit drop;
grant all on r2534_fail to authenticated;

-- ════ PARSE ════════════════════════════════════════════════════════════════════════
insert into r2534_fail
select 'normalize_bank_ref(' || n || ', ' || coalesce(r, 'null') || ') = ' || coalesce(public.normalize_bank_ref(n, r), 'null') || ' (want ' || coalesce(k, 'null') || ')'
  from (values
  ('NEFT CR-DBSS0IN0811-SURESH KUMAR AND COMPANY (IMPEX) PR-EXCEL TECHNOLOGIES-0811OP6167031041', '0811OP6167031041', '811OP6167031041'),
  ('NEFT CR-YESB0000001-RAZORPAY SOFTWARE PRIVATE LIMITED-EXCEL TECHNOLOGIES-YESBN12026110612345', null, 'YESBN12026110612345'),
  ('NEFT CR-SBIN0001234-GIBI PAUL-EXCEL TECHNOLOGIES-SBIN426310123456', '0000SBIN426310123456', 'SBIN426310123456'),
  ('NEFT DR-BKID0006087-PRATIK-NETBANK, MUM-N310261234567890-INVOICE 12345678', null, 'N310261234567890'),
  ('RTGS CR-SBIN0000001-ACME INFRA LTD-EXCEL TECHNOLOGIES-SBINR52026110600012345', null, 'SBINR52026110600012345'),
  ('RTGS DR-ICIC0000104-REDINGTON LIMITED-NETBANK, MUM-HDFCR52026110612345678-PO 7781', null, 'HDFCR52026110612345678'),
  ('IMPS-621856395591-RAVI KUMAR-ICIC-XX XXXXXX4658-SALARY', '0000621856395591', '621856395591'),
  ('IMPS-529912345679-SA-HDFC-50100784857169-INV', null, '529912345679'),
  ('UPI-MOHIT SHARMA-919876543210@PAYTM-PYTM0123456-621812345678-PAYMENT FROM PHONE', '0000621812345678', '621812345678'),
  ('UPI-GOOGLE INDIA DIGITAL-GOOGLEPAY@AXISBANK-UTIB0000553-530112345601-UPI', null, '530112345601'),
  ('CHQ DEP - MICR CTS - NAGPUR - SHARMA TRADERS', '000000123456', '123456'),
  ('CHQ PAID-MICR CTS-MU-VERMA CONTRACTORS', '0000000000004521', '4521'),
  ('UPI/621856395591/Payment from Ph/ravi@okicici/ICICI Bank', null, '621856395591'),
  ('MMT/IMPS/530412345678/INV 221/MEHTA TRADERS/HDFC Bank', null, '530412345678'),
  ('NEFT-HDFCN52026110612345-KAPOOR LEGAL-INV 88-50200012345678-HDFC0000240', null, 'HDFCN52026110612345'),
  ('RTGS-UTIBR52026110600054321-ACME INFRA LTD-PO 12-917020012345678-UTIB0000004', null, 'UTIBR52026110600054321'),
  ('CLG/SHARMA TRADERS/CHQ NO 004587/HDFC', null, '4587'),
  ('UPI/P2A/530912345678/ASHA DIRECTOR/HDFC BANK/rent', null, '530912345678'),
  ('NEFT/AXISP00123456789/GUPTA PRINT HOUSE/ICICI BANK/INV 44', null, 'AXISP00123456789'),
  ('IMPS/P2A/531012345678/VERMA CONTRACTORS/9876543210/advance', null, '531012345678'),
  ('INB/NEFT/AXOIC12345678901/SHARMA ASSOCIATES', null, 'AXOIC12345678901'),
  ('BY CLG/CHEQUE NO. 000781/KAPOOR CA', null, '781'),
  ('BY TRANSFER-NEFT*HDFC0000001*N310261234500001*BETHELSOFT INDIA*', null, 'N310261234500001'),
  ('TO TRANSFER-UPI/DR/531112345678/RK INFRA/SBIN/rkinfra@sbi/rent', null, '531112345678'),
  ('BY TRANSFER-UPI/CR/531212345678/MS TIWARI/HDFC/tiwari@okhdfcbank/inv', null, '531212345678'),
  ('BY TRANSFER-INB IMPS531312345678/9876543210/XX4521/ash', null, '531312345678'),
  ('CHQ TRANSFER-012345-SHARMA TRADERS', null, '12345'),
  ('SWEEP TRF FROM FD 50300123456789', '000050300123456789', null),
  ('50100123456789-TPT-RENT OCT-RAVI KUMAR', '0000000000000000', null),
  ('INTEREST PAID TILL 31-MAR-2026', null, null),
  ('NEFT ACME 1838 SALE', null, null),
  ('NEFT CR R2364 ZERO REF', '000000000000', null),
  ('UPI-ASHA DIRECTOR-ASHA@OKSBI-SBIN0001234-UPI', '0000531412345678', '531412345678'),
  ('NEFT CR-HDFC0000240-KAPOOR LEGAL-EXCEL TECHNOLOGIES', 'HDFCN52026110699999', 'HDFCN52026110699999')
  ) v(n, r, k)
 where public.normalize_bank_ref(n, r) is distinct from k;

insert into r2534_fail
select 'bank_ref_matches(' || coalesce(r, 'null') || ', ' || coalesce(k, 'null') || ') wrong (want ' || w || ')'
  from (values
    ('0000621856395591', '621856395591', true),
    ('UTR: 0811OP6167031041 (Suresh)', '811OP6167031041', true),
    ('INV 781 / 2026', '781', false),
    ('000781', '781', true),
    ('', '621856395591', false),
    ('621856395591', null, false)
  ) v(r, k, w)
 where coalesce(public.bank_ref_matches(r, k), false) is distinct from w;

-- ════ Fixtures: company A (R2534 Co) and company B ═════════════════════════════════
insert into auth.users (id, email) values
  ('e2534000-0000-4000-8000-0000000000a2', 'r2534-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2534000-0000-0000-0000-0000000000a0', 'R2534 Co', 'r2534@example.in', '07', 'R253'),
  ('e2534000-0000-0000-0000-0000000000b0', 'R2534 Other Co', 'r2534b@example.in', '07', 'R25B');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2534000-0000-4000-8000-0000000000a2', 'e2534000-0000-0000-0000-0000000000a0', 'r2534-owner@example.in', 'R2534 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2534000-0000-4000-8000-0000000000c1', 'e2534000-0000-0000-0000-0000000000a0', 'R2534 Kapoor Legal', '07', 'India'),
  ('e2534000-0000-4000-8000-0000000000c2', 'e2534000-0000-0000-0000-0000000000a0', 'R2534 Same Amount Traders', '07', 'India'),
  ('e2534000-0000-4000-8000-0000000000c9', 'e2534000-0000-0000-0000-0000000000b0', 'R2534 B Customer', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e2534000-0000-4000-8000-0000000000ba', 'e2534000-0000-0000-0000-0000000000a0', 'R2534 Current', 'R2534 Bank'),
  ('e2534000-0000-4000-8000-0000000000bb', 'e2534000-0000-0000-0000-0000000000a0', 'R2534 Twin UTR', 'R2534 Bank'),
  ('e2534000-0000-4000-8000-0000000000b9', 'e2534000-0000-0000-0000-0000000000b0', 'R2534 B Current', 'R2534 Bank');

-- L1: the UTR line. L2: an IMPS debit (FILL). L3: the twin-UTR line (own account). LB: company B's line.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit) values
  ('e2534000-0000-4000-8000-0000000000e1', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000ba', '2026-10-10', 'NEFT CR-HDFC0000240-KAPOOR LEGAL-EXCEL TECHNOLOGIES-HDFCN52026110612345', null, 5000, 0),
  ('e2534000-0000-4000-8000-0000000000e2', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000ba', '2026-10-11', 'IMPS-621856395591-RAVI KUMAR-ICIC-XX XXXXXX4658-SALARY', '0000621856395591', 0, 700),
  ('e2534000-0000-4000-8000-0000000000e3', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000bb', '2026-10-12', 'NEFT CR-HDFC0000240-TWIN-EXCEL TECHNOLOGIES-HDFCN52026110677777', null, 8000, 0),
  ('e2534000-0000-4000-8000-0000000000e9', 'e2534000-0000-0000-0000-0000000000b0', 'e2534000-0000-4000-8000-0000000000b9', '2026-10-10', 'UPI/531112345678/B PAYER/b@okhdfc/HDFC', null, 100, 0);

-- ════ FILL ═════════════════════════════════════════════════════════════════════════
insert into r2534_fail
select 'on insert, line ' || bt.id || ' ref_key = ' || coalesce(bt.ref_key, 'null') || ' (want ' || v.w || ')'
  from public.bank_transactions bt
  join (values ('e2534000-0000-4000-8000-0000000000e1'::uuid, 'HDFCN52026110612345'),
               ('e2534000-0000-4000-8000-0000000000e2'::uuid, '621856395591'),
               ('e2534000-0000-4000-8000-0000000000e9'::uuid, '531112345678')) v(i, w) on v.i = bt.id
 where bt.ref_key is distinct from v.w;

update public.bank_transactions set description = 'IMPS-621856395592-RAVI KUMAR-ICIC-SALARY'
 where id = 'e2534000-0000-4000-8000-0000000000e2';
insert into r2534_fail
select 'after the narration edit, ref_key = ' || coalesce(ref_key, 'null') || ' (want 621856395592)'
  from public.bank_transactions where id = 'e2534000-0000-4000-8000-0000000000e2' and ref_key is distinct from '621856395592';

-- ════ BACKFILL (the migration's own statement, limited to this test's two companies) ═══
-- Writing ref_key alone does not fire trg_bank_txn_ref_key (UPDATE OF description, reference).
update public.bank_transactions set ref_key = null
 where id in ('e2534000-0000-4000-8000-0000000000e1', 'e2534000-0000-4000-8000-0000000000e9');
do $$
declare v_n1 integer; v_n2 integer;
begin
  update public.bank_transactions bt
     set ref_key = public.normalize_bank_ref(bt.description, bt.reference)
   where bt.ref_key is distinct from public.normalize_bank_ref(bt.description, bt.reference)
     and bt.tenant_id in ('e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-0000-0000-0000000000b0');
  get diagnostics v_n1 = row_count;
  update public.bank_transactions bt
     set ref_key = public.normalize_bank_ref(bt.description, bt.reference)
   where bt.ref_key is distinct from public.normalize_bank_ref(bt.description, bt.reference)
     and bt.tenant_id in ('e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-0000-0000-0000000000b0');
  get diagnostics v_n2 = row_count;
  if v_n1 <> 2 then insert into r2534_fail values ('backfill wrote ' || v_n1 || ' rows (want 2: the two emptied lines)'); end if;
  if v_n2 <> 0 then insert into r2534_fail values ('backfill run twice wrote ' || v_n2 || ' rows (want 0)'); end if;
end $$;
insert into r2534_fail
select 'after backfill, line ' || id || ' (company ' || tenant_id || ') ref_key = ' || coalesce(ref_key, 'null')
  from public.bank_transactions
 where (id = 'e2534000-0000-4000-8000-0000000000e1' and ref_key is distinct from 'HDFCN52026110612345')
    or (id = 'e2534000-0000-4000-8000-0000000000e9' and ref_key is distinct from '531112345678');

-- ════ MATCH ════════════════════════════════════════════════════════════════════════
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
select 'Q-R2534-' || k, t::uuid, null, c::uuid, n, amt, round(amt / 1.18), 18, 'accepted', 'awaiting', '[]'::jsonb
  from (values ('1', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000c1', 'R2534 Kapoor Legal', 5000),
               ('2', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000c2', 'R2534 Same Amount Traders', 5000),
               ('3', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000c1', 'R2534 Kapoor Legal', 8000),
               ('4', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000c2', 'R2534 Same Amount Traders', 8000),
               ('9', 'e2534000-0000-0000-0000-0000000000b0', 'e2534000-0000-4000-8000-0000000000c9', 'R2534 B Customer', 5000)) v(k, t, c, n, amt);
insert into public.payments (id, tenant_id, customer_id, amount, method, reference, status, received_at, quote_id) values
  -- P1: carries the line's UTR (typed with a prefix, lower case), 15 days after the line.
  ('e2534000-0000-4000-8000-0000000000f1', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000c1', 5000, 'bank_transfer', 'UTR hdfcn52026110612345', 'received', '2026-10-25 10:00+05:30', 'Q-R2534-1'),
  -- P2: same amount on the line's own day, no reference — 'exact' before R-2534.
  ('e2534000-0000-4000-8000-0000000000f2', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000c2', 5000, 'cheque', 'R2534 NOREF', 'received', '2026-10-10 10:00+05:30', 'Q-R2534-2'),
  -- P3 / P4: two receipts carrying the same UTR (method cheque: R-1676's one-UTR-once rule is for UPI / transfer).
  ('e2534000-0000-4000-8000-0000000000f3', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000c1', 8000, 'cheque', 'HDFCN52026110677777', 'received', '2026-10-12 10:00+05:30', 'Q-R2534-3'),
  ('e2534000-0000-4000-8000-0000000000f4', 'e2534000-0000-0000-0000-0000000000a0', 'e2534000-0000-4000-8000-0000000000c2', 8000, 'cheque', 'HDFCN52026110677777', 'received', '2026-10-12 11:00+05:30', 'Q-R2534-4'),
  -- P9: company B's receipt carrying company A's UTR.
  ('e2534000-0000-4000-8000-0000000000f9', 'e2534000-0000-0000-0000-0000000000b0', 'e2534000-0000-4000-8000-0000000000c9', 5000, 'bank_transfer', 'HDFCN52026110612345', 'received', '2026-10-10 10:00+05:30', 'Q-R2534-9');

do $$
declare v_first record; v_conf text; v_ids text[]; v_res jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2534000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  select s.match_id, s.match_confidence into v_first
    from public.suggest_bank_transaction_matches('e2534000-0000-4000-8000-0000000000e1') with ordinality s(match_type, match_id, match_label, match_amount, match_date, match_confidence, ord)
   order by s.ord limit 1;
  if v_first.match_id is distinct from 'e2534000-0000-4000-8000-0000000000f1' or v_first.match_confidence is distinct from 'exact' then
    insert into r2534_fail values ('UTR line: first suggestion is ' || coalesce(v_first.match_id, 'none') || ' ' || coalesce(v_first.match_confidence, '') || ' (want P1 exact)');
  end if;
  select s.match_confidence into v_conf from public.suggest_bank_transaction_matches('e2534000-0000-4000-8000-0000000000e1') s
   where s.match_id = 'e2534000-0000-4000-8000-0000000000f2';
  if v_conf is distinct from 'high' then
    insert into r2534_fail values ('UTR line: same-day same-amount P2 without the reference is ' || coalesce(v_conf, 'not shown') || ' (want high)');
  end if;
  select array_agg(s.match_id) into v_ids from public.suggest_bank_transaction_matches('e2534000-0000-4000-8000-0000000000e1') s;
  if 'e2534000-0000-4000-8000-0000000000f9' = any (coalesce(v_ids, '{}')) then
    insert into r2534_fail values ('UTR line is offered company B''s receipt');
  end if;

  select array_agg(s.match_confidence order by s.match_id) into v_ids from public.suggest_bank_transaction_matches('e2534000-0000-4000-8000-0000000000e3') s;
  if v_ids is distinct from array['exact', 'exact'] then
    insert into r2534_fail values ('twin UTR line: confidences ' || coalesce(array_to_string(v_ids, ','), 'none') || ' (want exact,exact)');
  end if;

  v_res := public.auto_reconcile_bank_account('e2534000-0000-4000-8000-0000000000ba');
  v_res := public.auto_reconcile_bank_account('e2534000-0000-4000-8000-0000000000bb');
  set local role postgres;
  if not exists (select 1 from public.bank_transactions where id = 'e2534000-0000-4000-8000-0000000000e1'
                  and matched_to_type = 'payment' and matched_to_id = 'e2534000-0000-4000-8000-0000000000f1') then
    insert into r2534_fail values ('auto-reconcile did not book the UTR line to P1');
  end if;
  if exists (select 1 from public.bank_transactions where id = 'e2534000-0000-4000-8000-0000000000e3' and matched_to_type is not null) then
    insert into r2534_fail values ('auto-reconcile booked the twin-UTR line although two receipts carry its UTR');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2534_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2534_bank_ref_key:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2534_bank_ref_key';
end $$;

rollback;
