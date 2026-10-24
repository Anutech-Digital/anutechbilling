\set ON_ERROR_STOP on
-- R-1583 (P1): partner commission TDS (s.194H) defaults to 2% (TDS_SECTION_RATES), not 5%.
-- Migration: 20261018191711_r1583_194h_tds_default.sql.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1583_194h_tds_default.test.sql
--
-- Expect "PASS r1583_194h_tds_default". Every check is collected and failures listed together.
--
--   HELPER    public.tds_194h_default_rate() = 2; both tds_rate column defaults use it.
--   NO-5      neither accrue function falls back to a literal rate any more.
--   DEFAULT   partner + agreement created WITHOUT a rate → ₹11,800 paid on an 18% deal
--             → commission ₹1,000 (10% of ₹10,000 ex-GST), TDS ₹20 (2%), net ₹980.
--   EXPLICIT  an agreement with tds_rate 1 keeps 1% → TDS ₹10, net ₹990.
--   PROJECT   a ₹11,800 project payment (18%) on the DEFAULT agreement → TDS ₹20 too.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1583000-0000-0000-0000-0000000000a0', 'R1583 A', 'r1583a@example.in', '07', 'R183');
insert into public.customers (id, tenant_id, name, country, state_code, state) values
  ('e1583000-0000-4000-8000-0000000000c1', 'e1583000-0000-0000-0000-0000000000a0', 'R1583 Default Cust', 'India', '07', 'Delhi'),
  ('e1583000-0000-4000-8000-0000000000c2', 'e1583000-0000-0000-0000-0000000000a0', 'R1583 Explicit Cust', 'India', '07', 'Delhi');

-- No tds_rate given → the column default decides.
insert into public.referral_partners (id, tenant_id, name, deduct_tds) values
  ('e1583000-0000-4000-8000-0000000000e1', 'e1583000-0000-0000-0000-0000000000a0', 'R1583 Partner', true);
insert into public.referral_agreements (id, tenant_id, partner_id, customer_id, basis, percent, scope, deduct_tds, status) values
  ('e1583000-0000-4000-8000-0000000000f1', 'e1583000-0000-0000-0000-0000000000a0', 'e1583000-0000-4000-8000-0000000000e1',
   'e1583000-0000-4000-8000-0000000000c1', 'percent', 10, 'recurring', true, 'active');
insert into public.referral_agreements (id, tenant_id, partner_id, customer_id, basis, percent, scope, deduct_tds, tds_rate, status) values
  ('e1583000-0000-4000-8000-0000000000f2', 'e1583000-0000-0000-0000-0000000000a0', 'e1583000-0000-4000-8000-0000000000e1',
   'e1583000-0000-4000-8000-0000000000c2', 'percent', 10, 'recurring', true, 1, 'active');

insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount) values
  ('R1583-Q-DEF', 'e1583000-0000-0000-0000-0000000000a0', 'R1583 Default Cust',  'e1583000-0000-4000-8000-0000000000c1', 18, 11800),
  ('R1583-Q-EXP', 'e1583000-0000-0000-0000-0000000000a0', 'R1583 Explicit Cust', 'e1583000-0000-4000-8000-0000000000c2', 18, 11800);
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at) values
  ('e1583000-0000-4000-8000-0000000000d1', 'e1583000-0000-0000-0000-0000000000a0', 'R1583-Q-DEF', 'e1583000-0000-4000-8000-0000000000c1', 11800, 'upi', 'received', now(), now()),
  ('e1583000-0000-4000-8000-0000000000d2', 'e1583000-0000-0000-0000-0000000000a0', 'R1583-Q-EXP', 'e1583000-0000-4000-8000-0000000000c2', 11800, 'upi', 'received', now(), now());

insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, gst_rate) values
  ('e1583000-0000-4000-8000-0000000000b1', 'e1583000-0000-0000-0000-0000000000a0', 'e1583000-0000-4000-8000-0000000000c1',
   'R1583 Default Cust', 'R1583 Project', 10000, 1800, 11800, 18);
insert into public.project_payments (id, tenant_id, project_id, amount, method) values
  ('e1583000-0000-4000-8000-0000000000d3', 'e1583000-0000-0000-0000-0000000000a0', 'e1583000-0000-4000-8000-0000000000b1', 11800, 'bank');

create temp table r1583_fail (msg text) on commit drop;

do $$
declare r record; v text;
begin
  if coalesce(public.tds_194h_default_rate(), -1) <> 2 then
    insert into r1583_fail values (format('HELPER: tds_194h_default_rate() = %s (want 2)', public.tds_194h_default_rate()));
  end if;
  for r in select table_name, column_default from information_schema.columns
            where table_schema = 'public' and table_name in ('referral_partners', 'referral_agreements') and column_name = 'tds_rate' loop
    if r.column_default is distinct from 'tds_194h_default_rate()' then
      insert into r1583_fail values (format('HELPER: %s.tds_rate default is %s (want tds_194h_default_rate())', r.table_name, r.column_default));
    end if;
  end loop;
  for r in select proname, prosrc from pg_proc
            where proname in ('fn_accrue_referral_commission', 'fn_accrue_referral_commission_project')
              and pronamespace = 'public'::regnamespace loop
    if r.prosrc ~* 'coalesce\(\s*v_agr\.tds_rate\s*,\s*\d' then
      insert into r1583_fail values (format('NO-5: %s still falls back to a literal rate', r.proname));
    end if;
  end loop;

  select tds_rate::text into v from public.referral_partners where id = 'e1583000-0000-4000-8000-0000000000e1';
  if v::numeric <> 2 then insert into r1583_fail values (format('DEFAULT: new partner tds_rate %s (want 2)', v)); end if;

  select gross_commission, tds_amount, net_payable into r from public.referral_commissions where payment_id = 'e1583000-0000-4000-8000-0000000000d1';
  if not found then insert into r1583_fail values ('DEFAULT: no commission accrued on the payment');
  elsif r.gross_commission <> 1000 or r.tds_amount <> 20 or r.net_payable <> 980 then
    insert into r1583_fail values (format('DEFAULT: gross %s tds %s net %s (want 1000 / 20 / 980 — 2%%)', r.gross_commission, r.tds_amount, r.net_payable));
  end if;

  select gross_commission, tds_amount, net_payable into r from public.referral_commissions where payment_id = 'e1583000-0000-4000-8000-0000000000d2';
  if not found then insert into r1583_fail values ('EXPLICIT: no commission accrued on the payment');
  elsif r.tds_amount <> 10 or r.net_payable <> 990 then
    insert into r1583_fail values (format('EXPLICIT: tds %s net %s (want 10 / 990 — the agreement''s own 1%%)', r.tds_amount, r.net_payable));
  end if;

  select gross_commission, tds_amount into r from public.referral_commissions where project_payment_id = 'e1583000-0000-4000-8000-0000000000d3';
  if not found then insert into r1583_fail values ('PROJECT: no commission accrued on the project payment');
  elsif r.gross_commission <> 1000 or r.tds_amount <> 20 then
    insert into r1583_fail values (format('PROJECT: gross %s tds %s (want 1000 / 20)', r.gross_commission, r.tds_amount));
  end if;
end $$;

do $$
declare n int; m text;
begin
  select count(*), string_agg(msg, E'\n') into n, m from r1583_fail;
  if n > 0 then raise exception E'FAIL r1583_194h_tds_default (% checks):\n%', n, m; end if;
  raise notice 'PASS r1583_194h_tds_default';
end $$;

rollback;
