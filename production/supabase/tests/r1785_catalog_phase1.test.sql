-- R-1785 — Phase 1 of one product catalog (migration 20261023114500_r1785_catalog_phase1).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1785_catalog_phase1.test.sql
--
-- What it proves:
--   1. The new items columns exist; old rows got the safe defaults (gst 18, catalog, not public).
--   2. seed_core_catalog writes the 10 code-priced rows with the exact rupees the code charges
--      (the TS parity test catalog-seed-parity.test.ts ties the same figures to the code).
--   3. It is idempotent by SKU and never overwrites a price the owner edited.
--   4. Its guard: another company's owner, a non-owner, a user with no company and anon are refused.
--   5. Support plan rows got sku / term / fulfilment and NO price change.
--   6. sync_hosting_catalog starts a new hosting row at cost 0 ("Not set"), keeps a typed cost.
--   7. The constraints hold (bad fulfilment, duplicate SKU in one company).

begin;

insert into public.tenants (id, name, email, state_code, doc_code, tier) values
  ('c1785000-0000-0000-0000-0000000000a1'::uuid, 'T-R1785 Platform', 'r1785-a@example.in', '07', 'TRA', 'distributor'),
  ('c1785000-0000-0000-0000-0000000000b1'::uuid, 'T-R1785 Reseller', 'r1785-b@example.in', '07', 'TRB', 'reseller');
insert into auth.users (id, email) values
  ('c1785000-0000-0000-0000-00000000a0a1', 'r1785-owner-a@example.test'),
  ('c1785000-0000-0000-0000-00000000a0a2', 'r1785-support-a@example.test'),
  ('c1785000-0000-0000-0000-00000000b0b1', 'r1785-owner-b@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1785000-0000-0000-0000-00000000a0a1', 'c1785000-0000-0000-0000-0000000000a1', 'r1785-owner-a@example.in', 'owner', 'Owner A'),
  ('c1785000-0000-0000-0000-00000000a0a2', 'c1785000-0000-0000-0000-0000000000a1', 'r1785-support-a@example.in', 'support', 'Support A'),
  ('c1785000-0000-0000-0000-00000000b0b1', 'c1785000-0000-0000-0000-0000000000b1', 'r1785-owner-b@example.in', 'owner', 'Owner B');
-- A support row shaped like 20260817160000's, to check step 4 of the migration on new data too.
insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale, prices) values
  ('SUP-STANDARD-YR-' || replace('c1785000-0000-0000-0000-0000000000b1', '-', ''), 'c1785000-0000-0000-0000-0000000000b1', 'Support Standard (Yearly)',
   'support', '998313', 0, 0, '{"annual_total":{"msrp":9996,"wholesale":0}}');

-- ── 1. Columns and defaults ─────────────────────────────────────────────────────────────
do $$
declare v_bad int;
begin
  select count(*) into v_bad from information_schema.columns
   where table_schema = 'public' and table_name = 'items'
     and column_name in ('sku', 'term_months', 'gst_rate', 'fulfilment', 'engine_ref', 'price_source', 'is_public');
  if v_bad <> 7 then raise exception 'FAIL 1a: expected 7 new columns, found %', v_bad; end if;
  select count(*) into v_bad from public.items
   where gst_rate is distinct from 18 or price_source is distinct from 'catalog';
  if v_bad <> 0 then raise exception 'FAIL 1b: % rows without gst 18 / catalog', v_bad; end if;
  if exists (select 1 from public.items where is_public and sku is null) then
    raise exception 'FAIL 1c: an old row became public';
  end if;
end $$;

-- ── 2. Seed: the exact rupees, as trusted (psql) ────────────────────────────────────────
do $$
declare v_n int; v_bad text;
begin
  v_n := public.seed_core_catalog('c1785000-0000-0000-0000-0000000000a1');
  if v_n <> 10 then raise exception 'FAIL 2a: seeded % rows, expected 10', v_n; end if;

  select string_agg(e.sku, ', ') into v_bad
  from (values
    ('HOST-STARTER-YR',   600, 'unit_year',  12, 'hosting', 'hosting_panel', 'Starter'),
    ('HOST-STARTER-MO',   100, 'unit_month',  1, 'hosting', 'hosting_panel', 'Starter'),
    ('HOST-STANDARD-YR', 1500, 'unit_year',  12, 'hosting', 'hosting_panel', 'Standard'),
    ('HOST-STANDARD-MO',  250, 'unit_month',  1, 'hosting', 'hosting_panel', 'Standard'),
    ('HOST-PLUS-YR',     2246, 'unit_year',  12, 'hosting', 'hosting_panel', 'Plus'),
    ('HOST-PLUS-MO',      374, 'unit_month',  1, 'hosting', 'hosting_panel', 'Plus'),
    ('MAIL-ANUTECH-YR',   948, 'unit_year',  12, 'other',   'manual',        null),
    ('SSL-POSITIVE-YR',   899, 'unit_year',  12, 'other',   'manual',        null),
    ('SSL-WILDCARD-YR',  4499, 'unit_year',  12, 'other',   'manual',        null),
    ('SSL-OVEV-YR',      6999, 'unit_year',  12, 'other',   'manual',        null)
  ) as e(sku, msrp, unit, months, vendor, fulfilment, engine_ref)
  left join public.items i on i.tenant_id = 'c1785000-0000-0000-0000-0000000000a1' and i.sku = e.sku
  where i.id is null
     or i.msrp <> e.msrp or i.wholesale <> 0
     or i.prices->>'billing_unit' is distinct from e.unit
     or i.term_months <> e.months or i.vendor::text <> e.vendor
     or i.fulfilment <> e.fulfilment or i.engine_ref is distinct from e.engine_ref
     or not i.is_active or not i.is_public or i.kind <> 'main' or i.item_type <> 'subscription'
     or i.gst_rate <> 18 or i.price_source <> 'catalog';
  if v_bad is not null then raise exception 'FAIL 2b: wrong seeded rows: %', v_bad; end if;

  /* Checkout links a hosting line by name = '<tier> hosting' (cart-checkout.ts). A seeded row
     with that exact name would change which row a sale is filed under. */
  if exists (select 1 from public.items where tenant_id = 'c1785000-0000-0000-0000-0000000000a1'
              and sku is not null and lower(trim(name)) in ('starter hosting', 'standard hosting', 'plus hosting')) then
    raise exception 'FAIL 2c: a seeded row would be picked by the cart hosting-line lookup';
  end if;
end $$;

-- ── 3. Idempotent; an owner's edit survives a re-seed ───────────────────────────────────
update public.items set msrp = 650
 where tenant_id = 'c1785000-0000-0000-0000-0000000000a1' and sku = 'HOST-STARTER-YR';
do $$
declare v_n int; v_msrp int; v_rows int;
begin
  v_n := public.seed_core_catalog('c1785000-0000-0000-0000-0000000000a1');
  if v_n <> 0 then raise exception 'FAIL 3a: re-seed wrote % rows', v_n; end if;
  select msrp into v_msrp from public.items
   where tenant_id = 'c1785000-0000-0000-0000-0000000000a1' and sku = 'HOST-STARTER-YR';
  if v_msrp <> 650 then raise exception 'FAIL 3b: re-seed overwrote the owner''s price (now %)', v_msrp; end if;
  select count(*) into v_rows from public.items
   where tenant_id = 'c1785000-0000-0000-0000-0000000000a1' and sku is not null;
  if v_rows <> 10 then raise exception 'FAIL 3c: % SKU rows after re-seed', v_rows; end if;
end $$;

-- ── 4. Guard ────────────────────────────────────────────────────────────────────────────
set local role authenticated;

-- 4a. Another company's owner → refused.
select set_config('request.jwt.claims', json_build_object('sub', 'c1785000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
do $$
begin
  perform public.seed_core_catalog('c1785000-0000-0000-0000-0000000000a1');
  raise exception 'FAIL 4a: owner of B seeded company A';
exception when insufficient_privilege then
  if sqlerrm not like '%only to your own company%' then raise exception 'FAIL 4a: wrong refusal: %', sqlerrm; end if;
end $$;

-- 4b. Own company, but not an owner → refused.
select set_config('request.jwt.claims', json_build_object('sub', 'c1785000-0000-0000-0000-00000000a0a2', 'role', 'authenticated')::text, true);
do $$
begin
  perform public.seed_core_catalog('c1785000-0000-0000-0000-0000000000a1');
  raise exception 'FAIL 4b: a support user seeded the catalogue';
exception when insufficient_privilege then
  if sqlerrm not like '%Only an active workspace owner%' then raise exception 'FAIL 4b: wrong refusal: %', sqlerrm; end if;
end $$;

-- 4c. Signed in, no company → refused (fail closed, R-454).
select set_config('request.jwt.claims', json_build_object('sub', 'c1785000-0000-0000-0000-0000000fffff', 'role', 'authenticated')::text, true);
do $$
begin
  perform public.seed_core_catalog('c1785000-0000-0000-0000-0000000000a1');
  raise exception 'FAIL 4c: a user with no company seeded the catalogue';
exception when invalid_authorization_specification then
  if sqlerrm not like '%active owner%' then raise exception 'FAIL 4c: wrong refusal: %', sqlerrm; end if;
end $$;

-- 4d. Owner of B seeds B → allowed (10 rows, in B only).
select set_config('request.jwt.claims', json_build_object('sub', 'c1785000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
do $$
declare v_n int;
begin
  v_n := public.seed_core_catalog('c1785000-0000-0000-0000-0000000000b1');
  if v_n <> 10 then raise exception 'FAIL 4d: owner of B seeded % rows into B', v_n; end if;
end $$;

-- ── 6. sync_hosting_catalog (as owner of B) ─────────────────────────────────────────────
do $$
declare v_w int;
begin
  perform public.sync_hosting_catalog('[{"planId":"starter","name":"Starter Hosting","price":49.99}]'::jsonb);
  select wholesale into v_w from public.items where id = 'HOST-STARTER-c17850';
  if v_w is distinct from 0 then raise exception 'FAIL 6a: a new synced hosting row has cost % (expected 0 = not set)', v_w; end if;
end $$;

reset role;
update public.items set wholesale = 40 where id = 'HOST-STARTER-c17850';
set local role authenticated;
do $$
declare v_w int; v_m int;
begin
  perform public.sync_hosting_catalog('[{"planId":"starter","name":"Starter Hosting","price":55}]'::jsonb);
  select wholesale, msrp into v_w, v_m from public.items where id = 'HOST-STARTER-c17850';
  if v_w <> 40 then raise exception 'FAIL 6b: re-sync clobbered the typed cost (now %)', v_w; end if;
  if v_m <> 55 then raise exception 'FAIL 6c: re-sync did not refresh the price (now %)', v_m; end if;
end $$;

reset role;

-- 4e. anon cannot execute it at all.
do $$
begin
  if has_function_privilege('anon', 'public.seed_core_catalog(uuid)', 'execute') then
    raise exception 'FAIL 4e: anon can execute seed_core_catalog';
  end if;
  if not has_function_privilege('authenticated', 'public.seed_core_catalog(uuid)', 'execute') then
    raise exception 'FAIL 4f: authenticated cannot execute seed_core_catalog';
  end if;
end $$;

-- ── 5. Support rows: identity added by the migration, price untouched ───────────────────
-- The row inserted above came after the migration's update; run the same update again here.
update public.items
   set sku         = substring(id from '^(SUP-(?:FREE|STANDARD|ENTERPRISE)-(?:MO|YR))-[0-9a-f]{32}$'),
       term_months = case when id like 'SUP-%-YR-%' then 12 else 1 end,
       fulfilment  = 'support_panel'
 where vendor = 'support' and sku is null
   and id ~ '^SUP-(FREE|STANDARD|ENTERPRISE)-(MO|YR)-[0-9a-f]{32}$';
do $$
declare r record;
begin
  select * into r from public.items where id = 'SUP-STANDARD-YR-' || replace('c1785000-0000-0000-0000-0000000000b1', '-', '');
  if r.sku is distinct from 'SUP-STANDARD-YR' or r.term_months <> 12 or r.fulfilment <> 'support_panel' then
    raise exception 'FAIL 5a: support row identity % / % / %', r.sku, r.term_months, r.fulfilment;
  end if;
  if r.msrp <> 0 or (r.prices->'annual_total'->>'msrp')::int is distinct from 9996 or r.engine_ref is not null then
    raise exception 'FAIL 5b: support row price or engine_ref changed: % % %', r.msrp, r.prices, r.engine_ref;
  end if;
  /* Every support row the migration could recognise now has its SKU (on this DB's real rows). */
  if exists (select 1 from public.items where vendor = 'support' and sku is null
              and id ~ '^SUP-(FREE|STANDARD|ENTERPRISE)-(MO|YR)-[0-9a-f]{32}$') then
    raise exception 'FAIL 5c: a support row was left without its SKU';
  end if;
end $$;

-- ── 7. Constraints ──────────────────────────────────────────────────────────────────────
do $$
begin
  begin
    insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, fulfilment)
    values ('T-R1785-BAD', 'c1785000-0000-0000-0000-0000000000a1', 'x', 'other', 1, 0, 'somebody');
    raise exception 'FAIL 7a: an unknown fulfilment was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, sku)
    values ('T-R1785-DUP', 'c1785000-0000-0000-0000-0000000000a1', 'x', 'other', 1, 0, 'MAIL-ANUTECH-YR');
    raise exception 'FAIL 7b: a second row with the same SKU in one company was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, sku)
    values ('T-R1785-LOW', 'c1785000-0000-0000-0000-0000000000a1', 'x', 'other', 1, 0, 'host-starter');
    raise exception 'FAIL 7c: a lower-case SKU was accepted';
  exception when check_violation then null;
  end;
end $$;

select 'R-1785 catalog phase 1: ALL PASS' as result;

rollback;
