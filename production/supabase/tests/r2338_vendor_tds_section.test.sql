-- R-2338 (1 Nov 2026, p1, G-RECON; owner + CA): a vendor's TDS section is saved only when the
-- owner ticks "Remember for this vendor" — never by itself; and the 194J sub-sections (194JA
-- technical services 2%, 194JB professional fees 10%, 194JR royalty 10%) are stored as they are.
-- Migration: 20261101050022_r2338_vendor_tds_section.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Sidhshree-like vendor (no default section): an expense bill paid from Reconcile with
--      194JA TDS 2% and NO remember flag → bill paid with TDS 194JA, the vendor's default TDS
--      section stays empty (before R-2338 the RPC set it by itself).
--   B. Same vendor, next bill, remember_tds_section = true → the vendor's default becomes 194JA.
--   C. Google-like vendor: a new expense bill typed in Reconcile with 194JR 10% and remember →
--      the new bill carries 194JR, the vendor's default becomes 194JR.
--   D. A vendor whose default is 194JB, paid under 194JA without remember → stays 194JB.
--   E. The vendors shape check takes the three new codes (and still refuses junk).

begin;

create function pg_temp.r2338_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2338_supplier before insert on public.tenants for each row execute function pg_temp.r2338_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000233801','R2338 Co','r2338@example.in','07','R2338');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000233801','owner2338@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000233801','dddddddd-0000-0000-0000-000000233801','owner2338@example.in','Owner 2338','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000233801','dddddddd-0000-0000-0000-000000233801','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category, default_tds_section) values
  ('eeeeeeee-0000-0000-0000-000000233801','dddddddd-0000-0000-0000-000000233801','Sidhshree Test','07AAKFS2338A1Z5','AAKFS2338A','Software', null),
  ('eeeeeeee-0000-0000-0000-000000233802','dddddddd-0000-0000-0000-000000233801','Google India Test','07AACCG2338A1Z5','AACCG2338A','Software', null),
  ('eeeeeeee-0000-0000-0000-000000233803','dddddddd-0000-0000-0000-000000233801','Pankaj CA Test',null,'ABCPK2338A','Professional Services', '194JB');

insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid) values
  ('EXP-R2338-S1','dddddddd-0000-0000-0000-000000233801','Software','Sidhshree Test','eeeeeeee-0000-0000-0000-000000233801','2026-10-01',60000,0,'none','S-1',false),
  ('EXP-R2338-S2','dddddddd-0000-0000-0000-000000233801','Software','Sidhshree Test','eeeeeeee-0000-0000-0000-000000233801','2026-10-02',10000,0,'none','S-2',false),
  ('EXP-R2338-P1','dddddddd-0000-0000-0000-000000233801','Professional Services','Pankaj CA Test','eeeeeeee-0000-0000-0000-000000233803','2026-10-03',60000,0,'none','P-1',false);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000233801','dddddddd-0000-0000-0000-000000233801','bbbbbbbb-0000-0000-0000-000000233801','2026-10-10','NEFT SIDHSHREE 1',58800,0,'S1','csv_upload'),
  ('11111111-0000-0000-0000-000000233802','dddddddd-0000-0000-0000-000000233801','bbbbbbbb-0000-0000-0000-000000233801','2026-10-11','NEFT SIDHSHREE 2',9800,0,'S2','csv_upload'),
  ('11111111-0000-0000-0000-000000233803','dddddddd-0000-0000-0000-000000233801','bbbbbbbb-0000-0000-0000-000000233801','2026-10-12','NEFT GOOGLE',90000,0,'G1','csv_upload'),
  ('11111111-0000-0000-0000-000000233804','dddddddd-0000-0000-0000-000000233801','bbbbbbbb-0000-0000-0000-000000233801','2026-10-13','NEFT PANKAJ',58800,0,'P1','csv_upload');

-- Owner 2338 signs in.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000233801","role":"authenticated"}', true);

-- ── A. 194JA 2%, no remember → the vendor is NOT taught ───────────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000233801','eeeeeeee-0000-0000-0000-000000233801', null,
    '[{"source":"expense","doc_id":"EXP-R2338-S1","amount":60000,"tds_amount":1200,"tds_section":"194JA"}]'::jsonb);
  if (select tds_section from public.expenses where id = 'EXP-R2338-S1') is distinct from '194JA'
     or (select tds_amount from public.expenses where id = 'EXP-R2338-S1') is distinct from 1200
     or not (select paid from public.expenses where id = 'EXP-R2338-S1') then
    raise exception 'A FAIL: bill not paid with 194JA TDS 1200 (%)', r; end if;
  if (r->>'tds_section') is distinct from '194JA' then raise exception 'A FAIL: result %', r; end if;
  if (select default_tds_section from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000233801') is not null then
    raise exception 'A FAIL: vendor section set by itself to % — only the owner sets it',
      (select default_tds_section from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000233801'); end if;
  raise notice 'A ok: 194JA TDS ₹1,200 booked; vendor default left empty (no remember)';
end $$;

-- ── B. remember_tds_section → the vendor's default becomes 194JA ─────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000233802','eeeeeeee-0000-0000-0000-000000233801', null,
    '[{"source":"expense","doc_id":"EXP-R2338-S2","amount":10000,"tds_amount":200,"tds_section":"194JA","remember_tds_section":true}]'::jsonb);
  if (select default_tds_section from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000233801') is distinct from '194JA' then
    raise exception 'B FAIL: vendor default % (want 194JA)',
      (select default_tds_section from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000233801'); end if;
  raise notice 'B ok: owner ticked Remember → vendor default 194JA';
end $$;

-- ── C. New bill in Reconcile, royalty 10%, remember → 194JR on the bill and the vendor ────────
do $$
declare r jsonb; e public.expenses;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000233803','eeeeeeee-0000-0000-0000-000000233802', null, '[]'::jsonb,
    '{"kind":"expense","bill_no":"G-1","bill_date":"2026-10-12","category":"Software","taxable":100000,"gst":0,"itc":false,
      "tds_amount":10000,"tds_section":"194JR","remember_tds_section":true,"pay":100000}'::jsonb);
  select * into e from public.expenses where vendor_id = 'eeeeeeee-0000-0000-0000-000000233802';
  if e.tds_section is distinct from '194JR' or e.tds_amount is distinct from 10000 then
    raise exception 'C FAIL: new bill % % (want 194JR 10000) — %', e.tds_section, e.tds_amount, r; end if;
  if (select default_tds_section from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000233802') is distinct from '194JR' then
    raise exception 'C FAIL: vendor default % (want 194JR)',
      (select default_tds_section from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000233802'); end if;
  raise notice 'C ok: new bill royalty 194JR ₹10,000; vendor default 194JR (remembered)';
end $$;

-- ── D. A saved default is not overwritten without remember ───────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000233804','eeeeeeee-0000-0000-0000-000000233803', null,
    '[{"source":"expense","doc_id":"EXP-R2338-P1","amount":60000,"tds_amount":1200,"tds_section":"194JA"}]'::jsonb);
  if (select default_tds_section from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000233803') is distinct from '194JB' then
    raise exception 'D FAIL: vendor default changed to % without the owner''s tick',
      (select default_tds_section from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000233803'); end if;
  raise notice 'D ok: default 194JB kept when paid under 194JA without remember';
end $$;

-- ── E. The vendor shape check takes the new codes, refuses junk ──────────────────────────────
do $$
begin
  update public.vendors set default_tds_section = '194JB' where id = 'eeeeeeee-0000-0000-0000-000000233802';
  update public.vendors set default_tds_section = '194JR' where id = 'eeeeeeee-0000-0000-0000-000000233802';
  begin
    update public.vendors set default_tds_section = '194J(a)' where id = 'eeeeeeee-0000-0000-0000-000000233802';
    raise exception 'E FAIL: junk section 194J(a) accepted';
  exception when check_violation then null;
  end;
  raise notice 'E ok: 194JA / 194JB / 194JR fit the vendor section check; junk refused';
end $$;

rollback;
