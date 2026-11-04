-- R-2470 (4 Nov 2026) — independent money review 4, R-2447 F1/F2
-- (Anutech-HQ/drafts/REVIEWS/2026-11-04-money-cards-4.md). Two old gaps in the quote approval guard:
--   F1. generate_invoice invoices from the quote HEADER (amount, subtotal, discount_pct, tax_rate), but
--       the approval trigger did not watch those columns — a rep could set discount_pct = 45 on an
--       approved quote and the bank-receipt path invoiced the cut price under the old approval.
--       Now a header change that favours the customer (deeper header discount, lower amount or
--       subtotal, a number blanked, any tax-rate change) sends the quote back to pending, like a stale
--       line edit; raising the price keeps the approval.
--   F2. the DB never set below_cost (the R-2213 payment guard's only input) itself. Now a login's
--       insert, and a login's line edit that moves the lines' numbers, marks the quote below cost when
--       its lines are (marginBps(lineEconomics) < 0 — quote_lines_approval_bps, R-2447) — so the
--       payment guard applies. A date-only line write (the bank-credit RPCs) does not touch it.
--   Service paths (no login) are unchanged.
-- Migration 20261104211846_r2470_quote_approval_header_below_cost.
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

create function pg_temp.r2470_login(p_uid text) returns text language sql as $l$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true)
$l$;
grant execute on function pg_temp.r2470_login(text) to authenticated;

-- Lines: 3 × rate (list ₹500), cost each. 500/350 → discount 0, margin 30%.
create function pg_temp.r2470_lines(p_rate int, p_cost int, p_start text default null) returns jsonb
language sql as $f$
  select jsonb_build_array(jsonb_build_object('id', 'l1', 'name', 'Google Workspace Business Standard', 'qty', 3,
           'rate', p_rate, 'list_rate', 500, 'cost', p_cost, 'commitment', 'annual_yearly')
         || case when p_start is null then '{}'::jsonb else jsonb_build_object('start_date', p_start) end)
$f$;
grant execute on function pg_temp.r2470_lines(int, int, text) to authenticated;

-- An APPROVED quote (made by the current login), signed as postgres (no trigger) by the manager.
create function pg_temp.r2470_approved_quote(p_id text, p_lines jsonb default null) returns void
language plpgsql as $q$
begin
  insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                             discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                             approval_status, approval_tier)
  values (p_id, 'dddddddd-0000-0000-0000-000000247001', 'cccccccc-0000-0000-0000-000000247001', 'Cust 2470',
          'Google Workspace Business Standard', 3, 1770, 1500, 1050, 0, 18, 'draft', 'yearly',
          coalesce(p_lines, pg_temp.r2470_lines(500, 350)), false, '2026-11-04', 'pending', 'manager');
  alter table public.quotes disable trigger trg_quote_approval_not_by_maker;
  update public.quotes set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000247003',
         approved_at = now() - interval '1 hour', approved_discount_bps = 0, approved_margin_bps = 3000 where id = p_id;
  alter table public.quotes enable trigger trg_quote_approval_not_by_maker;
end $q$;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000247001','R2470 Co','r2470@example.in','07','R2470');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000247001','own2470@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000247003','mgr2470@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000247004','sales2470@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000247001','dddddddd-0000-0000-0000-000000247001','own2470@example.in','Owner','owner', true, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000247003','dddddddd-0000-0000-0000-000000247001','mgr2470@example.in','Manager','manager', true, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000247004','dddddddd-0000-0000-0000-000000247001','sales2470@example.in','Sales','sales', true, now() - interval '30 days');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000247001','dddddddd-0000-0000-0000-000000247001','Cust 2470','07','c2470.in');

-- ── A. F1: header money fields on an approved quote (sales login) ─────────────────────────
select pg_temp.r2470_login('aaaaaaaa-0000-0000-0000-000000247004');
select pg_temp.r2470_approved_quote('Q-R2470-H1');   -- discount_pct 45 (the review's scenario)
select pg_temp.r2470_approved_quote('Q-R2470-H2');   -- amount cut
select pg_temp.r2470_approved_quote('Q-R2470-H3');   -- subtotal cut
select pg_temp.r2470_approved_quote('Q-R2470-H4');   -- tax rate changed
select pg_temp.r2470_approved_quote('Q-R2470-H5');   -- amount blanked
select pg_temp.r2470_approved_quote('Q-R2470-H6');   -- price raised (better deal)
select pg_temp.r2470_approved_quote('Q-R2470-H7');   -- header discount 10% (manager tier)
update public.quotes set discount_pct = 45 where id = 'Q-R2470-H1';
update public.quotes set amount = 1000 where id = 'Q-R2470-H2';
update public.quotes set subtotal = 900 where id = 'Q-R2470-H3';
update public.quotes set tax_rate = 5 where id = 'Q-R2470-H4';
update public.quotes set amount = null where id = 'Q-R2470-H5';
update public.quotes set amount = 1888, subtotal = 1600 where id = 'Q-R2470-H6';
update public.quotes set discount_pct = 10 where id = 'Q-R2470-H7';
do $$
declare v_id text; v_q record;
begin
  foreach v_id in array array['Q-R2470-H1', 'Q-R2470-H2', 'Q-R2470-H3', 'Q-R2470-H4', 'Q-R2470-H5', 'Q-R2470-H7'] loop
    select * into v_q from public.quotes where id = v_id;
    if v_q.approval_status::text <> 'pending' or v_q.approved_by is not null or v_q.approved_discount_bps is not null
       or v_q.approval_requested_by <> 'aaaaaaaa-0000-0000-0000-000000247004' then
      raise exception 'FAIL A: % kept its approval after a header money change: %', v_id, row_to_json(v_q);
    end if;
    if not exists (select 1 from public.activity_log where entity_id = v_id and action = 'quote.approval_reset') then
      raise exception 'FAIL A: no activity_log line for the reset of %', v_id;
    end if;
  end loop;
  if (select approval_tier::text from public.quotes where id = 'Q-R2470-H1') <> 'owner' then
    raise exception 'FAIL A: a 45%% header discount went back to the manager queue';
  end if;
  if (select approval_tier::text from public.quotes where id = 'Q-R2470-H7') <> 'manager' then
    raise exception 'FAIL A: a 10%% header discount needs only a manager';
  end if;
  if (select approval_status::text from public.quotes where id = 'Q-R2470-H6') <> 'approved' then
    raise exception 'FAIL A: raising the price knocked the approval off';
  end if;
  raise notice 'PASS A: a header cut on an approved quote sends it back for approval; a price rise keeps it';
end $$;

-- A2. the rep cannot cut the header and keep it approved by re-signing in the same update
select pg_temp.r2470_approved_quote('Q-R2470-H8');
do $$
declare v_msg text;
begin
  begin
    update public.quotes set discount_pct = 45, approved_discount_bps = 4500, approved_at = now() where id = 'Q-R2470-H8';
    v_msg := 'ACCEPTED';
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg not like 'You cannot approve Q-R2470-H8%' then
    raise exception 'FAIL A2: a rep re-signed a header cut: %', v_msg;
  end if;
  raise notice 'PASS A2: a header cut with a re-signing is a signing (rep refused)';
end $$;

-- A3. the review's scenario end to end: discount_pct 45 → the invoice's taxable (825) is under the
--     lines' cost (1050) → below cost, owner tier, and money on it waits (R-2213 payment guard).
-- A4. subtotal raised with the amount kept → the invoice's GST would drop → stale too.
-- A5. the same cut written together with approval_status = 'not_required' → still marked below cost,
--     so leaving 'approved' in the same write does not let the money through.
-- A6. an approved quote with no amount gets one → stale (it was not invoiceable when signed).
-- A7. the cut written together with currency = 'USD' is still checked in ₹.
select pg_temp.r2470_approved_quote('Q-R2470-H9');
select pg_temp.r2470_approved_quote('Q-R2470-H10');
select pg_temp.r2470_approved_quote('Q-R2470-H11');
select pg_temp.r2470_approved_quote('Q-R2470-H12');
select pg_temp.r2470_approved_quote('Q-R2470-H13');   -- A7: cut + switched to USD in one write
alter table public.quotes disable trigger trg_quote_approval_not_by_maker;
update public.quotes set amount = null where id = 'Q-R2470-H12';
alter table public.quotes enable trigger trg_quote_approval_not_by_maker;
update public.quotes set discount_pct = 45 where id = 'Q-R2470-H9';
update public.quotes set subtotal = 1770 where id = 'Q-R2470-H10';
update public.quotes set discount_pct = 45, approval_status = 'not_required' where id = 'Q-R2470-H11';
update public.quotes set amount = 10 where id = 'Q-R2470-H12';
update public.quotes set discount_pct = 45, currency = 'USD' where id = 'Q-R2470-H13';
do $$
declare v_id text; v_msg text;
begin
  if (select approval_tier::text <> 'owner' or not below_cost from public.quotes where id = 'Q-R2470-H9') then
    raise exception 'FAIL A3: a header cut under cost was not marked below cost / owner tier';
  end if;
  foreach v_id in array array['Q-R2470-H9', 'Q-R2470-H11', 'Q-R2470-H13'] loop
    if not (select below_cost from public.quotes where id = v_id) then
      raise exception 'FAIL A3/A5: % not marked below cost', v_id;
    end if;
    begin
      insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference)
      values ('dddddddd-0000-0000-0000-000000247001', v_id, 'cccccccc-0000-0000-0000-000000247001', 1000, 'cash', 'C' || v_id);
      v_msg := 'ACCEPTED';
    exception when others then v_msg := sqlerrm;
    end;
    if v_msg not like 'This quote is below cost and waits for the owner''s approval.%' then
      raise exception 'FAIL A3/A5: payment on % after a header cut: %', v_id, v_msg;
    end if;
  end loop;
  foreach v_id in array array['Q-R2470-H10', 'Q-R2470-H12'] loop
    if (select approval_status::text from public.quotes where id = v_id) <> 'pending' then
      raise exception 'FAIL A4/A6: % kept its approval', v_id;
    end if;
  end loop;
  raise notice 'PASS A3-A6: a header cut under cost blocks the money; GST-lowering and newly-set amounts reset too';
end $$;

-- ── B. F2: a login's insert with below-cost lines is marked below cost → payment waits ──────
set local role authenticated;
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                           approval_status, approval_tier, below_cost)
values ('Q-R2470-I1', 'dddddddd-0000-0000-0000-000000247001', 'cccccccc-0000-0000-0000-000000247001', 'Cust 2470',
        'Google Workspace Business Standard', 3, 1062, 900, 1050, 0, 18, 'sent', 'yearly',
        pg_temp.r2470_lines(300, 350), false, '2026-11-04', 'not_required', null, false),
       ('Q-R2470-I2', 'dddddddd-0000-0000-0000-000000247001', 'cccccccc-0000-0000-0000-000000247001', 'Cust 2470',
        'Google Workspace Business Standard', 3, 1770, 1500, 1050, 0, 18, 'sent', 'yearly',
        pg_temp.r2470_lines(500, 350), false, '2026-11-04', 'not_required', null, false),
       ('Q-R2470-I3', 'dddddddd-0000-0000-0000-000000247001', 'cccccccc-0000-0000-0000-000000247001', 'Cust 2470',
        'Google Workspace Business Standard', 3, 708, 1500, 1050, 60, 18, 'sent', 'yearly',
        pg_temp.r2470_lines(500, 350), false, '2026-11-04', 'not_required', null, false);
reset role;
do $$
declare v_msg text;
begin
  if not (select below_cost from public.quotes where id = 'Q-R2470-I1') then
    raise exception 'FAIL B: a below-cost insert kept below_cost = false';
  end if;
  if (select below_cost from public.quotes where id = 'Q-R2470-I2') then
    raise exception 'FAIL B: a healthy insert was marked below cost';
  end if;
  if not (select below_cost from public.quotes where id = 'Q-R2470-I3') then
    raise exception 'FAIL B: healthy lines with a 60%% header discount (taxable under cost) were not marked';
  end if;
  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference)
    values ('dddddddd-0000-0000-0000-000000247001', 'Q-R2470-I1', 'cccccccc-0000-0000-0000-000000247001', 1062, 'cash', 'C2470');
    v_msg := 'ACCEPTED';
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg not like 'This quote is below cost and waits for the owner''s approval.%' then
    raise exception 'FAIL B: payment on the below-cost quote: %', v_msg;
  end if;
  raise notice 'PASS B: a below-cost insert is marked below cost and its payment waits for the owner';
end $$;

-- ── C. F2: a login reprices a not-required / pending quote below cost → marked ──────────────
update public.quotes set line_items = pg_temp.r2470_lines(320, 350), below_cost = false where id = 'Q-R2470-I2';
do $$
begin
  if not (select below_cost from public.quotes where id = 'Q-R2470-I2') then
    raise exception 'FAIL C: repricing below cost kept below_cost = false';
  end if;
  raise notice 'PASS C: repricing below cost marks the quote below cost';
end $$;

-- ── D. a date-only line write (bank-credit RPCs) on an old approved quote does not flip it ────
select pg_temp.r2470_approved_quote('Q-R2470-D1', pg_temp.r2470_lines(300, 350));   -- legacy: below cost, flag false
update public.quotes set line_items = pg_temp.r2470_lines(300, 350, '2026-11-05') where id = 'Q-R2470-D1';
do $$
begin
  if (select approval_status::text <> 'approved' or below_cost from public.quotes where id = 'Q-R2470-D1') then
    raise exception 'FAIL D: a date-only line write changed the approval / below_cost';
  end if;
  raise notice 'PASS D: a date-only line write leaves the approval alone';
end $$;

-- ── E. service path (no login) unchanged ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '', true);
select pg_temp.r2470_approved_quote('Q-R2470-S1');
update public.quotes set discount_pct = 45, amount = 900 where id = 'Q-R2470-S1';
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                           approval_status, below_cost)
values ('Q-R2470-S2', 'dddddddd-0000-0000-0000-000000247001', 'cccccccc-0000-0000-0000-000000247001', 'Cust 2470',
        'Google Workspace Business Standard', 3, 1062, 900, 1050, 0, 18, 'sent', 'yearly',
        pg_temp.r2470_lines(300, 350), false, '2026-11-04', 'not_required', false);
do $$
begin
  if (select approval_status::text from public.quotes where id = 'Q-R2470-S1') <> 'approved'
     or (select below_cost from public.quotes where id = 'Q-R2470-S2') then
    raise exception 'FAIL E: the service path changed';
  end if;
  raise notice 'PASS E: service path unchanged';
end $$;

rollback;
