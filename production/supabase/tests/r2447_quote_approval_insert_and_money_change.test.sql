-- R-2447 (3 Nov 2026) + independent money review 3 F1 (Anutech-HQ/drafts/REVIEWS/2026-11-04-money-cards-3.md):
-- the quote approval guard (tg_quote_approval_not_by_maker, R-2367/R-2383/R-2426/R-2441) ran only on an
-- UPDATE of approval_status / approved_by. Gaps closed here:
--   1. INSERT: a login's direct insert cannot create a quote that is already approved / rejected, and
--      cannot carry signed numbers or a signer; combine_quotes (SECURITY DEFINER) still copies its
--      sources' approval onto the combined quote.
--   2. below_cost turning true on an approved quote sends it back for (owner) approval; a login cannot
--      take the below-cost mark off.
--   3. F1: on an approved quote the signed numbers (approved_discount_bps / approved_margin_bps),
--      approval_tier and approved_at cannot be rewritten without a fresh signing — the role check
--      runs again (a rep is refused; the approver re-signing is fine).
--   4. F1: a line edit that makes the approval stale (discount deeper, margin thinner, margin now
--      unknown, or a number unknown at sign-off that now needs sign-off by itself — the same rule as isStale in
--      src/lib/quotes/approval.ts) sends the quote back to pending; an edit that improves the deal
--      or does not move money (dates on a line — the bank-credit RPCs) keeps the approval.
--   5. A service path (no login) is unchanged.
-- Migration 20261103202530_r2447_quote_approval_insert_and_money_change.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.

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

create function pg_temp.r2447_login(p_uid text) returns text language sql as $l$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true)
$l$;
grant execute on function pg_temp.r2447_login(text) to authenticated;

-- Lines: 3 × ₹500 (list ₹500), cost ₹350 → discount 0 bps, margin 3000 bps (30%).
create function pg_temp.r2447_lines(p_rate int, p_cost int, p_list int default 500, p_start text default null) returns jsonb
language sql as $f$
  select jsonb_build_array(jsonb_build_object('id', 'l1', 'name', 'Google Workspace Business Standard', 'qty', 3,
           'rate', p_rate, 'list_rate', p_list, 'cost', p_cost, 'commitment', 'annual_yearly')
         || case when p_start is null then '{}'::jsonb else jsonb_build_object('start_date', p_start) end)
$f$;
grant execute on function pg_temp.r2447_lines(int, int, int, text) to authenticated;

-- An APPROVED quote made by the CURRENT login, signed (as postgres, no trigger) by p_signer with the
-- lines' own numbers.
create function pg_temp.r2447_approved_quote(p_id text, p_signer uuid, p_tier text default 'manager',
                                             p_disc int default 0, p_margin int default 3000) returns void
language plpgsql as $q$
begin
  insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                             discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                             approval_status, approval_tier)
  values (p_id, 'dddddddd-0000-0000-0000-000000244701', 'cccccccc-0000-0000-0000-000000244701', 'Cust 2447',
          'Google Workspace Business Standard', 3, 1770, 1500, 1050, 0, 18, 'draft', 'yearly',
          pg_temp.r2447_lines(500, 350), false, '2026-11-03', 'pending', p_tier::public.quote_approval_tier);
  alter table public.quotes disable trigger trg_quote_approval_not_by_maker;
  update public.quotes set approval_status = 'approved', approved_by = p_signer, approved_at = now() - interval '1 hour',
         approved_discount_bps = p_disc, approved_margin_bps = p_margin where id = p_id;
  alter table public.quotes enable trigger trg_quote_approval_not_by_maker;
end $q$;

create function pg_temp.r2447_status(p_id text) returns text language sql as $s$
  select approval_status::text from public.quotes where id = p_id
$s$;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000244701','R2447 Co','r2447@example.in','07','R2447');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000244701','own2447@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244702','own2447b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244703','mgr2447@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244704','sales2447@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244705','bill2447@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000244701','dddddddd-0000-0000-0000-000000244701','own2447@example.in','Owner A','owner', true, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000244702','dddddddd-0000-0000-0000-000000244701','own2447b@example.in','Owner B','owner', true, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000244703','dddddddd-0000-0000-0000-000000244701','mgr2447@example.in','Manager','manager', true, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000244704','dddddddd-0000-0000-0000-000000244701','sales2447@example.in','Sales','sales', true, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000244705','dddddddd-0000-0000-0000-000000244701','bill2447@example.in','Billing','billing', true, now() - interval '30 days');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000244701','dddddddd-0000-0000-0000-000000244701','Cust 2447','07','c2447.in');

create temp table r2447_out (k text primary key, v text) on commit drop;
grant all on r2447_out to authenticated;

-- ── 1. INSERT by a login (PostgREST runs as role authenticated) ─────────────────────────────
-- 1a. sales inserts a below-cost quote already approved (signed in the owner's name) → refused
-- 1b. even the owner cannot insert an approved / rejected quote directly (save, then Review & decide)
-- 1c. a pending insert that carries a signer / signed numbers keeps none of them
select pg_temp.r2447_login('aaaaaaaa-0000-0000-0000-000000244704');
set local role authenticated;
do $$
declare v_msg text; v_case record;
begin
  for v_case in select * from (values
      ('1a', 'aaaaaaaa-0000-0000-0000-000000244704', 'Q-R2447-I1', 'approved'),
      ('1b', 'aaaaaaaa-0000-0000-0000-000000244701', 'Q-R2447-I2', 'approved'),
      ('1b', 'aaaaaaaa-0000-0000-0000-000000244701', 'Q-R2447-I3', 'rejected')) t(k, who, id, st) loop
    perform pg_temp.r2447_login(v_case.who);
    v_msg := null;
    begin
      insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                                 discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                                 approval_status, approval_tier, approved_by, approved_at, approved_discount_bps,
                                 approved_margin_bps, below_cost)
      values (v_case.id, 'dddddddd-0000-0000-0000-000000244701', 'cccccccc-0000-0000-0000-000000244701', 'Cust 2447',
              'Google Workspace Business Standard', 3, 1180, 1000, 1050, 0, 18, 'draft', 'yearly',
              pg_temp.r2447_lines(333, 350), false, '2026-11-03',
              v_case.st::public.quote_approval_status, 'owner', 'aaaaaaaa-0000-0000-0000-000000244701', now(), 0, 2000, true);
      v_msg := 'ACCEPTED';
    exception when others then v_msg := sqlerrm;
    end;
    insert into r2447_out values (v_case.k || ':' || v_case.id, v_msg);
  end loop;

  perform pg_temp.r2447_login('aaaaaaaa-0000-0000-0000-000000244704');
  insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                             discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                             approval_status, approval_tier, approval_requested_by, approved_by, approved_at,
                             approved_discount_bps, approved_margin_bps)
  values ('Q-R2447-I4', 'dddddddd-0000-0000-0000-000000244701', 'cccccccc-0000-0000-0000-000000244701', 'Cust 2447',
          'Google Workspace Business Standard', 3, 1770, 1500, 1050, 0, 18, 'draft', 'yearly',
          pg_temp.r2447_lines(500, 350), false, '2026-11-03', 'pending', 'manager',
          'aaaaaaaa-0000-0000-0000-000000244704', 'aaaaaaaa-0000-0000-0000-000000244701', now(), 0, 3000);
  insert into r2447_out values ('1c', 'inserted');
end $$;
reset role;
do $$
declare r record;
begin
  for r in select * from r2447_out where k like '1%' loop
    if r.k like '1c%' then continue; end if;
    if r.v not like 'A new quote cannot be saved already%' then
      raise exception 'FAIL %: expected the insert refused, got: %', r.k, r.v;
    end if;
  end loop;
  if exists (select 1 from public.quotes where id in ('Q-R2447-I1', 'Q-R2447-I2', 'Q-R2447-I3')) then
    raise exception 'FAIL 1: a refused insert left a quote behind';
  end if;
  if (select approved_by is not null or approved_at is not null or approved_discount_bps is not null
             or approved_margin_bps is not null or approval_status::text <> 'pending'
        from public.quotes where id = 'Q-R2447-I4') then
    raise exception 'FAIL 1c: a pending insert kept a signer / signed numbers';
  end if;
  raise notice 'PASS 1: a login cannot insert an approved / rejected quote or pre-signed numbers';
end $$;

-- 1d. combine_quotes (SECURITY DEFINER) still copies the approval of its sources onto the new quote
select set_config('request.jwt.claims', '', true);
insert into public.quotes (id, tenant_id, customer_id, customer_name, currency, exchange_rate, tax_rate, status,
                           payment_status, discount_pct, line_items, subtotal, amount, created_at,
                           approval_status, approval_tier, approved_by, approved_at, approved_discount_bps, approved_margin_bps)
values
  ('Q-R2447-C1', 'dddddddd-0000-0000-0000-000000244701', 'cccccccc-0000-0000-0000-000000244701', 'Cust 2447', 'INR', 1, 18,
   'accepted', 'awaiting', 0, '[{"id":"C1","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1180, '2026-10-04T10:00:00Z',
   'approved', 'manager', 'aaaaaaaa-0000-0000-0000-000000244703', now() - interval '2 hours', 1500, 2500),
  ('Q-R2447-C2', 'dddddddd-0000-0000-0000-000000244701', 'cccccccc-0000-0000-0000-000000244701', 'Cust 2447', 'INR', 1, 18,
   'accepted', 'awaiting', 0, '[{"id":"C2","name":"Training","qty":1,"rate":2000,"cost":0}]', 2000, 2360, '2026-10-04T11:00:00Z',
   'not_required', null, null, null, null, null);
select pg_temp.r2447_login('aaaaaaaa-0000-0000-0000-000000244705');
set local role authenticated;
do $$
declare v_r jsonb;
begin
  v_r := public.combine_quotes(array['Q-R2447-C1', 'Q-R2447-C2']);
  insert into r2447_out values ('1d', v_r->>'quote_id');
exception when others then
  insert into r2447_out values ('1d', 'FAILED: ' || sqlerrm);
end $$;
reset role;
do $$
declare v_id text := (select v from r2447_out where k = '1d'); v_q record;
begin
  if v_id like 'FAILED%' then raise exception 'FAIL 1d: combine_quotes refused: %', v_id; end if;
  select * into v_q from public.quotes where id = v_id;
  if v_q.approval_status::text <> 'approved' or v_q.approved_by <> 'aaaaaaaa-0000-0000-0000-000000244703'
     or v_q.approved_discount_bps <> 1500 or v_q.approved_margin_bps <> 2500 then
    raise exception 'FAIL 1d: the combined quote lost its approval: %', row_to_json(v_q);
  end if;
  raise notice 'PASS 1d: combine_quotes still carries the sources'' approval';
end $$;

-- ── 2. below_cost turning true on an approved quote → back to the owner ────────────────────
select pg_temp.r2447_login('aaaaaaaa-0000-0000-0000-000000244704');
select pg_temp.r2447_approved_quote('Q-R2447-B1', 'aaaaaaaa-0000-0000-0000-000000244703');
update public.quotes set below_cost = true where id = 'Q-R2447-B1';
do $$
declare v_q record;
begin
  select * into v_q from public.quotes where id = 'Q-R2447-B1';
  if v_q.approval_status::text <> 'pending' or v_q.approval_tier::text <> 'owner' or v_q.approved_by is not null
     or v_q.approved_discount_bps is not null or v_q.approved_margin_bps is not null
     or v_q.approval_requested_by <> 'aaaaaaaa-0000-0000-0000-000000244704' then
    raise exception 'FAIL 2: below_cost flipped on an approved quote kept the approval: %', row_to_json(v_q);
  end if;
  if not exists (select 1 from public.activity_log where entity_id = 'Q-R2447-B1' and action = 'quote.approval_reset') then
    raise exception 'FAIL 2: no activity_log line for the reset';
  end if;
  raise notice 'PASS 2: below_cost on an approved quote sends it back for owner approval';
end $$;
-- 2b. a login cannot take the below-cost mark off while the lines are below cost (the R-2213 money
--     guard reads it); the R-2397 fixture path (lines at cost) still may — r2397 test E
update public.quotes set line_items = pg_temp.r2447_lines(300, 350) where id = 'Q-R2447-B1';
do $$
declare v_msg text;
begin
  begin
    update public.quotes set below_cost = false where id = 'Q-R2447-B1';
    v_msg := 'ACCEPTED';
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg not like 'Quote Q-R2447-B1 is below cost — that mark cannot be removed while the price is under cost%' then
    raise exception 'FAIL 2b: a login cleared below_cost: %', v_msg;
  end if;
  raise notice 'PASS 2b: the below-cost mark cannot be cleared by a login';
end $$;

-- ── 3. F1: signed numbers / tier / approved_at cannot be rewritten without re-signing ───────
select pg_temp.r2447_approved_quote('Q-R2447-F1', 'aaaaaaaa-0000-0000-0000-000000244703', 'manager', 1500, 3000);
do $$
declare v_case record; v_msg text;
begin
  for v_case in select * from (values
      ('3a null numbers', 'approved_discount_bps = null, approved_margin_bps = null'),
      ('3b matching numbers', 'approved_discount_bps = 4500, approved_margin_bps = -500'),
      ('3c tier', 'approval_tier = ''manager''::public.quote_approval_tier, approved_margin_bps = 2999'),
      ('3d approved_at', 'approved_at = now()')) t(k, set_sql) loop
    v_msg := null;
    begin
      execute 'update public.quotes set ' || v_case.set_sql || ' where id = ''Q-R2447-F1''';
      v_msg := 'ACCEPTED';
    exception when others then v_msg := sqlerrm;
    end;
    if v_msg not like 'You cannot approve Q-R2447-F1%' then
      raise exception 'FAIL %: sales rewrote the signed approval: %', v_case.k, v_msg;
    end if;
  end loop;
  if (select approved_discount_bps <> 1500 or approved_margin_bps <> 3000 or approval_status::text <> 'approved'
        from public.quotes where id = 'Q-R2447-F1') then
    raise exception 'FAIL 3: the signed numbers changed';
  end if;
  raise notice 'PASS 3a-d: a rep cannot null, rewrite or re-date the signed approval';
end $$;
-- 3e. the manager (the signer) re-signs new numbers in the same name → allowed, role checked
select pg_temp.r2447_login('aaaaaaaa-0000-0000-0000-000000244703');
update public.quotes set approved_discount_bps = 1800, approved_margin_bps = 2500, approved_at = now() where id = 'Q-R2447-F1';
-- 3f. but the manager cannot re-sign owner-tier numbers (margin under 12%)
do $$
declare v_msg text;
begin
  if (select approved_discount_bps from public.quotes where id = 'Q-R2447-F1') <> 1800 then
    raise exception 'FAIL 3e: the signer could not re-sign';
  end if;
  begin
    update public.quotes set approved_margin_bps = 500 where id = 'Q-R2447-F1';
    v_msg := 'ACCEPTED';
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg not like 'Only the owner can approve Q-R2447-F1%' then
    raise exception 'FAIL 3f: a manager re-signed owner-tier numbers: %', v_msg;
  end if;
  raise notice 'PASS 3e-f: the signer may re-sign within their role';
end $$;

-- ── 4. F1: line edits on an approved quote ───────────────────────────────────────────────
select pg_temp.r2447_login('aaaaaaaa-0000-0000-0000-000000244704');
select pg_temp.r2447_approved_quote('Q-R2447-L1', 'aaaaaaaa-0000-0000-0000-000000244703');   -- deeper discount
select pg_temp.r2447_approved_quote('Q-R2447-L2', 'aaaaaaaa-0000-0000-0000-000000244703');   -- below cost
select pg_temp.r2447_approved_quote('Q-R2447-L3', 'aaaaaaaa-0000-0000-0000-000000244703');   -- cost made unknown
select pg_temp.r2447_approved_quote('Q-R2447-L4', 'aaaaaaaa-0000-0000-0000-000000244703');   -- price raised
select pg_temp.r2447_approved_quote('Q-R2447-L5', 'aaaaaaaa-0000-0000-0000-000000244703');   -- only a date on the line
select pg_temp.r2447_approved_quote('Q-R2447-L6', 'aaaaaaaa-0000-0000-0000-000000244703', 'owner', null, null);  -- signed with unknown numbers
select pg_temp.r2447_approved_quote('Q-R2447-L7', 'aaaaaaaa-0000-0000-0000-000000244703', 'owner', null, null);  -- signed unknown, now healthy
select pg_temp.r2447_approved_quote('Q-R2447-L8', 'aaaaaaaa-0000-0000-0000-000000244703');   -- numbers as strings
update public.quotes set line_items = pg_temp.r2447_lines(275, 350)  where id = 'Q-R2447-L1';   -- 45% off, below cost
update public.quotes set line_items = pg_temp.r2447_lines(500, 520)  where id = 'Q-R2447-L2';   -- margin -4%
update public.quotes set line_items = pg_temp.r2447_lines(500, 0)    where id = 'Q-R2447-L3';   -- cost unknown
update public.quotes set line_items = pg_temp.r2447_lines(550, 350, 550) where id = 'Q-R2447-L4';   -- better deal
update public.quotes set line_items = pg_temp.r2447_lines(500, 350, 500, '2026-11-05') where id = 'Q-R2447-L5';
update public.quotes set line_items = pg_temp.r2447_lines(300, 280)  where id = 'Q-R2447-L6';   -- 40% off, 6.7% margin
update public.quotes set line_items = pg_temp.r2447_lines(520, 350, 520) where id = 'Q-R2447-L7';   -- 0% off, 32.7% margin
update public.quotes set line_items = '[{"id":"l1","name":"GW","qty":"3","rate":"275","list_rate":500,"cost":350}]'::jsonb
 where id = 'Q-R2447-L8';                                                                          -- 45% off as strings
do $$
declare v_id text;
begin
  foreach v_id in array array['Q-R2447-L1', 'Q-R2447-L2', 'Q-R2447-L3', 'Q-R2447-L6', 'Q-R2447-L8'] loop
    if pg_temp.r2447_status(v_id) <> 'pending'
       or (select approved_by is not null or approved_discount_bps is not null from public.quotes where id = v_id) then
      raise exception 'FAIL 4: % kept its approval after a line edit that makes it stale', v_id;
    end if;
  end loop;
  foreach v_id in array array['Q-R2447-L4', 'Q-R2447-L5', 'Q-R2447-L7'] loop
    if pg_temp.r2447_status(v_id) <> 'approved' then
      raise exception 'FAIL 4: % lost its approval on an edit that does not favour the customer', v_id;
    end if;
  end loop;
  -- the tier follows the NEW numbers: L1 was manager-tier, now 45% off → owner
  if (select approval_tier::text from public.quotes where id = 'Q-R2447-L1') <> 'owner' then
    raise exception 'FAIL 4: L1 went back to the manager queue with owner-tier numbers';
  end if;
  raise notice 'PASS 4: a stale line edit sends the quote back; improving it or editing a date keeps the approval';
end $$;

-- ── 5. service path (no login) unchanged ─────────────────────────────────────────────────
select pg_temp.r2447_approved_quote('Q-R2447-S1', 'aaaaaaaa-0000-0000-0000-000000244703');
select set_config('request.jwt.claims', '', true);
update public.quotes set line_items = pg_temp.r2447_lines(275, 350), below_cost = true where id = 'Q-R2447-S1';
do $$
begin
  if pg_temp.r2447_status('Q-R2447-S1') <> 'approved' then
    raise exception 'FAIL 5: the service path changed';
  end if;
  raise notice 'PASS 5: service path unchanged';
end $$;

rollback;
