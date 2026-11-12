-- R-2711 (12 Nov 2026): customer_payer_lines(customer) — the Known payers card's "Seen on which
-- lines" read, moved off the gateway-refused `.eq("payer->>customer_id", …)` filter.
-- Migration 20261112152104_r2711_customer_payer_lines. Self-asserting, ONE transaction, rolled back.
-- Run on a local/test DB only:
--   begin; <migration>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. Owner of company 1 gets exactly the RECONCILED lines answered for Links (newest first,
--      payer key returned); not the unreconciled one, not the one answered for Acme, not a line
--      with no payer / a payer without customer_id / a non-uuid customer_id (no error either).
--   B. A sales login of the same company sees the same lines (same rights as the old direct read).
--   C. Another company's owner gets 0 rows for Links, and its own line that names Links' id in
--      payer.customer_id is never shown to company 1 (tenant isolation).
--   D. anon cannot execute it (42501).
--   E. It is SECURITY INVOKER with search_path set.

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
  ('dddddddd-0000-0000-0000-000000271101','Orbit Software R2711','r2711@example.in','07','R2711'),
  ('dddddddd-0000-0000-0000-000000271102','R2711 Other','r2711b@example.in','07','R2711B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000271101','owner2711@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000271102','sales2711@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000271103','other2711@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000271101','dddddddd-0000-0000-0000-000000271101','owner2711@example.in','Owner 2711','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000271102','dddddddd-0000-0000-0000-000000271101','sales2711@example.in','Sales 2711','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000271103','dddddddd-0000-0000-0000-000000271102','other2711@example.in','Other 2711','owner', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000271101','dddddddd-0000-0000-0000-000000271101','Links Infotech 2711','07','links2711.in'),
  ('cccccccc-0000-0000-0000-000000271102','dddddddd-0000-0000-0000-000000271101','Acme 2711','07','acme2711.in');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000271101','dddddddd-0000-0000-0000-000000271101','IndusInd Current','IndusInd'),
  ('bbbbbbbb-0000-0000-0000-000000271102','dddddddd-0000-0000-0000-000000271102','Other bank','SBI');

-- payer / matched_to_type set directly as the superuser (the R-2025 flow is tested in r2025_customer_payers).
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source, payer, matched_to_type) values
  -- 1, 2: reconciled, answered for Links → shown (2 is newer → first)
  ('11111111-0000-0000-0000-000000271101','dddddddd-0000-0000-0000-000000271101','bbbbbbbb-0000-0000-0000-000000271101','2026-10-23',
   'NEFT CR-SHREE NANDIK-R2711A',0,16709,'R2711A','manual',
   '{"name":"Shree Nandik","key":"shree nandik","relation":"group_company","customer_id":"cccccccc-0000-0000-0000-000000271101"}','payment'),
  ('11111111-0000-0000-0000-000000271102','dddddddd-0000-0000-0000-000000271101','bbbbbbbb-0000-0000-0000-000000271101','2026-10-25',
   'NEFT CR-SHREE NANDIK-R2711B',0,5000,'R2711B','manual',
   '{"name":"Shree Nandik","key":"shree nandik","relation":"group_company","customer_id":"cccccccc-0000-0000-0000-000000271101"}','payment'),
  -- 3: answered for Links but NOT reconciled → hidden
  ('11111111-0000-0000-0000-000000271103','dddddddd-0000-0000-0000-000000271101','bbbbbbbb-0000-0000-0000-000000271101','2026-10-26',
   'NEFT CR-SHREE NANDIK-R2711C',0,700,'R2711C','manual',
   '{"name":"Shree Nandik","key":"shree nandik","relation":"group_company","customer_id":"cccccccc-0000-0000-0000-000000271101"}',null),
  -- 4: reconciled, answered for Acme → hidden from Links
  ('11111111-0000-0000-0000-000000271104','dddddddd-0000-0000-0000-000000271101','bbbbbbbb-0000-0000-0000-000000271101','2026-10-26',
   'NEFT CR-RAJESH-R2711D',0,7000,'R2711D','manual',
   '{"name":"Rajesh Kumar","key":"rajesh kumar","relation":"director","customer_id":"cccccccc-0000-0000-0000-000000271102"}','payment'),
  -- 5, 6, 7: no payer / payer without customer_id / customer_id not a uuid → hidden, no error
  ('11111111-0000-0000-0000-000000271105','dddddddd-0000-0000-0000-000000271101','bbbbbbbb-0000-0000-0000-000000271101','2026-10-26',
   'NEFT CR-PLAIN-R2711E',0,100,'R2711E','manual',null,'payment'),
  ('11111111-0000-0000-0000-000000271106','dddddddd-0000-0000-0000-000000271101','bbbbbbbb-0000-0000-0000-000000271101','2026-10-26',
   'NEFT CR-NOCUST-R2711F',0,200,'R2711F','manual','{"name":"No Cust","key":"no cust"}','payment'),
  ('11111111-0000-0000-0000-000000271107','dddddddd-0000-0000-0000-000000271101','bbbbbbbb-0000-0000-0000-000000271101','2026-10-26',
   'NEFT CR-BADID-R2711G',0,300,'R2711G','manual','{"name":"Bad Id","key":"bad id","customer_id":"not-a-uuid"}','payment'),
  -- 8: ANOTHER company's line naming Links' id → never shown to company 1
  ('11111111-0000-0000-0000-000000271108','dddddddd-0000-0000-0000-000000271102','bbbbbbbb-0000-0000-0000-000000271102','2026-10-27',
   'NEFT CR-X-R2711H',0,4000,'R2711H','manual',
   '{"name":"Someone","key":"someone","relation":"third_party","customer_id":"cccccccc-0000-0000-0000-000000271101"}','payment');

-- ── E. shape ────────────────────────────────────────────────────────────────
do $$
declare v_definer boolean; v_cfg text[];
begin
  select p.prosecdef, p.proconfig into v_definer, v_cfg
  from pg_proc p where p.oid = 'public.customer_payer_lines(uuid)'::regprocedure;
  if v_definer then raise exception 'FAIL E: customer_payer_lines must be SECURITY INVOKER (RLS decides)'; end if;
  if v_cfg is null or not exists (select 1 from unnest(v_cfg) c where c like 'search_path=%') then
    raise exception 'FAIL E: customer_payer_lines has no search_path set';
  end if;
end $$;

-- ── A. owner of company 1 ───────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000271101","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_ids text;
begin
  select string_agg(id::text || ':' || coalesce(payer_key, '-') || ':' || credit, ',')
    into v_ids from public.customer_payer_lines('cccccccc-0000-0000-0000-000000271101');
  if v_ids is distinct from
     '11111111-0000-0000-0000-000000271102:shree nandik:5000,11111111-0000-0000-0000-000000271101:shree nandik:16709' then
    raise exception 'FAIL A: owner got %, want lines 2 then 1 (reconciled, answered for Links)', v_ids;
  end if;
  if (select count(*) from public.customer_payer_lines('cccccccc-0000-0000-0000-000000271102')) <> 1 then
    raise exception 'FAIL A: Acme should show its one line';
  end if;
end $$;
reset role;

-- ── B. sales login of the same company: same rights as the old direct read ──
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000271102","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.customer_payer_lines('cccccccc-0000-0000-0000-000000271101')) <> 2 then
    raise exception 'FAIL B: sales login should see the same 2 lines';
  end if;
end $$;
reset role;

-- ── C. another company ──────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000271103","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_ids text;
begin
  select string_agg(id::text, ',') into v_ids from public.customer_payer_lines('cccccccc-0000-0000-0000-000000271101');
  -- its own line 8 names Links' id: it may see its own line, never company 1's
  if v_ids is distinct from '11111111-0000-0000-0000-000000271108' then
    raise exception 'FAIL C: other company got %, want only its own line 8', v_ids;
  end if;
end $$;
reset role;

-- ── D. anon ─────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform public.customer_payer_lines('cccccccc-0000-0000-0000-000000271101');
  raise exception 'FAIL D: anon could run customer_payer_lines';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
