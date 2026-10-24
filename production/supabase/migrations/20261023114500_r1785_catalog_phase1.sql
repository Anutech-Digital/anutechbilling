-- deploy-peek: exists(select 1 from pg_proc where proname = 'sync_hosting_catalog' and prosrc like '%R-1785%') and to_regprocedure('public.seed_core_catalog(uuid)') is not null
-- deploy-key: r1785catalog1
--
-- R-1785 — Phase 1 of "one product catalog, kept in Billing" (parent R-1784).
--
-- Today hosting, the Anutech Mail mailbox and the SSL certificates are priced ONLY in code
-- (site/lib/data/hosting-landing.ts LANDING_PLANS → lib/checkout/hosting-prices.ts
-- hostingRate; domains-landing.ts MAILBOX_YR; catalog.ts CERTS). The `items` table — what
-- quotes, invoices, subscriptions and packages already read — has no row for them that matches
-- what checkout charges, and no column that says the term, who fulfils it or which engine
-- package it is. This file only ADDS:
--
--   1. Columns on items (all nullable or defaulted, nothing reads them yet):
--        sku          tenant-free stable code, unique per tenant   (HOST-STARTER-YR, MAIL-ANUTECH-YR)
--        term_months  months one charge covers                     (1, 12)
--        gst_rate     GST % on the price                           (default 18)
--        fulfilment   who delivers it                              (reselleros / hosting_panel / support_panel / resellerclub / google / manual)
--        engine_ref   the engine's own key                         (DirectAdmin package "Starter")
--        price_source catalog = this row's msrp; vendor_live = read live from the vendor (domains, Phase 2)
--        is_public    shown on the website / panels                (default false)
--      `vendor` stays the product's function (hosting / support / domain / google …) — no
--      separate "function" column, so the same fact is not kept in two places.
--
--   2. public.seed_core_catalog(p_tenant) — ONE atomic, idempotent write of the code-priced
--      products into one company's catalogue, keyed by (tenant_id, sku). A row that already
--      has the SKU is left exactly as it is, so re-running never overwrites a price the owner
--      edited on the Items page. Prices are copied from the code, not invented:
--        HOST-<TIER>-YR  = hostingRate(tier, yearly)  = round(LANDING_PLANS.price × 12)  → 600 / 1500 / 2246
--        HOST-<TIER>-MO  = hostingRate(tier, monthly) = round(LANDING_PLANS.price × 2)   → 100 / 250 / 374
--        MAIL-ANUTECH-YR = MAILBOX_YR = 79 × 12                                          → 948
--        SSL-*-YR        = CERTS (Positive 899, Wildcard 4,499, OV/EV 6,999)
--      Whole rupees (CLAUDE.md §13). Yearly rows carry the year's total in msrp with
--      prices.billing_unit = 'unit_year' (R-526), monthly rows the month with 'unit_month', so
--      /items and the quote builder already show and price them correctly.
--      src/lib/catalog/catalog-seed-parity.test.ts fails if these figures and the code drift.
--      wholesale = 0: we have no cost for these, and 0 is how the app says "cost not set"
--      (/items shows "Not set" and leaves it out of the average margin — R-472).
--      Names keep "(Yearly)" / "(Monthly)", so the cart's hosting-line linking
--      (cart-checkout.ts: name = "<tier> hosting") does not change which row it picks.
--
--   3. Which companies get the rows: tier = 'distributor' only — the platform company
--      (CLAUDE.md §4a) that actually sells this hosting, mail and SSL on its website. Reseller
--      companies do not sell Anutech's hosting at Anutech's retail, so their quote pickers stay
--      as they are. A company that should have them later: an owner (or the manager from psql)
--      runs `select public.seed_core_catalog('<tenant id>')`.
--
--   4. The support plan rows (SUP-*-MO/YR, 20260817160000) get their sku, term_months and
--      fulfilment = 'support_panel' — NO price change, and NO engine_ref yet: which support-panel
--      tier (free/basic/moderate/premium) each one maps to waits for Pardeep's decision on R-1784.
--
--   5. sync_hosting_catalog no longer fills wholesale with the sale price on first import. That
--      made every synced hosting row read "margin 0%" — a cost nobody entered. It now starts at 0
--      ("Not set"); a cost the owner types is still preserved on re-sync. Rows already synced
--      keep their wholesale (changing stored data is Pardeep's call, not a migration's).
--
-- Nothing reads the new columns or rows to charge anyone (that is Phase 2, R-1786). Rollback:
-- leave the columns unused; nothing is dropped.
-- Test: supabase/tests/r1785_catalog_phase1.test.sql.

begin;

-- ── 1. Columns ─────────────────────────────────────────────────────────────────────────
alter table public.items
  add column if not exists sku          text,
  add column if not exists term_months  smallint,
  add column if not exists gst_rate     numeric(4,2) not null default 18,
  add column if not exists fulfilment   text,
  add column if not exists engine_ref   text,
  add column if not exists price_source text not null default 'catalog',
  add column if not exists is_public    boolean not null default false;

alter table public.items drop constraint if exists items_sku_format;
alter table public.items add constraint items_sku_format
  check (sku is null or sku ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$');

alter table public.items drop constraint if exists items_term_months_check;
alter table public.items add constraint items_term_months_check
  check (term_months is null or term_months between 1 and 120);

alter table public.items drop constraint if exists items_gst_rate_check;
alter table public.items add constraint items_gst_rate_check
  check (gst_rate >= 0 and gst_rate <= 28);

alter table public.items drop constraint if exists items_fulfilment_check;
alter table public.items add constraint items_fulfilment_check
  check (fulfilment is null or fulfilment in ('reselleros', 'hosting_panel', 'support_panel', 'resellerclub', 'google', 'manual'));

alter table public.items drop constraint if exists items_price_source_check;
alter table public.items add constraint items_price_source_check
  check (price_source in ('catalog', 'vendor_live'));

create unique index if not exists items_tenant_sku_uniq
  on public.items (tenant_id, sku) where sku is not null;

comment on column public.items.sku is
  'R-1785: tenant-free stable product code (HOST-STARTER-YR). Unique per tenant. `id` stays the key other tables point at.';
comment on column public.items.term_months is
  'R-1785: months one charge of this row covers (1 = monthly, 12 = yearly).';
comment on column public.items.gst_rate is
  'R-1785: GST percent on this row''s price. Default 18.';
comment on column public.items.fulfilment is
  'R-1785: who delivers the product — reselleros, hosting_panel, support_panel, resellerclub, google or manual.';
comment on column public.items.engine_ref is
  'R-1785: the engine''s own key — DirectAdmin package name, support-panel plan key, ResellerClub product key.';
comment on column public.items.price_source is
  'R-1785: catalog = the price on this row; vendor_live = read live from the vendor (domains: ResellerClub customer price).';
comment on column public.items.is_public is
  'R-1785: shown on the website and the hosting / support panels.';

-- ── 2. The seed RPC ────────────────────────────────────────────────────────────────────
create or replace function public.seed_core_catalog(p_tenant uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_count   integer;
begin
  /* R-1785: trusted server paths (migration, psql, service role) may seed any company; anyone
     else only their OWN company, as an active owner (R-454 / R-1615 fail-closed rule). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null and auth.uid() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted then
    v_caller := public.current_tenant_id();
    if v_caller is null then
      raise exception 'Adding the standard products needs an active owner who has finished sign-in. Sign in again and retry.'
        using errcode = '28000';
    end if;
    if p_tenant is distinct from v_caller then
      raise exception 'You can add the standard products only to your own company''s catalogue.'
        using errcode = '42501';
    end if;
    if not public.current_user_has_role('owner') then
      raise exception 'Only an active workspace owner can add products to the catalogue.'
        using errcode = '42501';
    end if;
  end if;

  if p_tenant is null or not exists (select 1 from public.tenants where id = p_tenant) then
    raise exception 'No such company — check the company id and retry.' using errcode = '22023';
  end if;

  with seed(sku, name, vendor, hsn, msrp, unit, term_months, fulfilment, engine_ref) as (
    values
      -- sku,               name,                             vendor,    hsn,      ₹ msrp, billing unit, months, fulfilment,      engine_ref
      ('HOST-STARTER-YR',  'Starter Hosting (Yearly)',        'hosting', '998315',   600, 'unit_year',  12, 'hosting_panel', 'Starter'),
      ('HOST-STARTER-MO',  'Starter Hosting (Monthly)',       'hosting', '998315',   100, 'unit_month',  1, 'hosting_panel', 'Starter'),
      ('HOST-STANDARD-YR', 'Standard Hosting (Yearly)',       'hosting', '998315',  1500, 'unit_year',  12, 'hosting_panel', 'Standard'),
      ('HOST-STANDARD-MO', 'Standard Hosting (Monthly)',      'hosting', '998315',   250, 'unit_month',  1, 'hosting_panel', 'Standard'),
      ('HOST-PLUS-YR',     'Plus Hosting (Yearly)',           'hosting', '998315',  2246, 'unit_year',  12, 'hosting_panel', 'Plus'),
      ('HOST-PLUS-MO',     'Plus Hosting (Monthly)',          'hosting', '998315',   374, 'unit_month',  1, 'hosting_panel', 'Plus'),
      ('MAIL-ANUTECH-YR',  'Anutech Mail mailbox (Yearly)',   'other',   '998313',   948, 'unit_year',  12, 'manual',        null),
      ('SSL-POSITIVE-YR',  'Positive SSL (Yearly)',           'other',   '998313',   899, 'unit_year',  12, 'manual',        null),
      ('SSL-WILDCARD-YR',  'Wildcard SSL (Yearly)',           'other',   '998313',  4499, 'unit_year',  12, 'manual',        null),
      ('SSL-OVEV-YR',      'OV / EV SSL (Yearly)',            'other',   '998313',  6999, 'unit_year',  12, 'manual',        null)
  ),
  ins as (
    insert into public.items (
      id, tenant_id, sku, name, vendor, hsn, msrp, wholesale,
      item_type, kind, is_active, prices,
      term_months, gst_rate, fulfilment, engine_ref, price_source, is_public
    )
    select
      s.sku || '-' || replace(p_tenant::text, '-', ''), p_tenant, s.sku, s.name, s.vendor::public.vendor, s.hsn, s.msrp, 0,
      'subscription', 'main', true, jsonb_build_object('billing_unit', s.unit),
      s.term_months, 18, s.fulfilment, s.engine_ref, 'catalog', true
    from seed s
    where not exists (select 1 from public.items i where i.tenant_id = p_tenant and i.sku = s.sku)
    on conflict (id) do nothing
    returning 1
  )
  select count(*) into v_count from ins;

  return v_count;
end $function$;

revoke all on function public.seed_core_catalog(uuid) from public;
revoke all on function public.seed_core_catalog(uuid) from anon;
grant execute on function public.seed_core_catalog(uuid) to authenticated;
grant execute on function public.seed_core_catalog(uuid) to service_role;

-- ── 3. Seed the platform company ───────────────────────────────────────────────────────
select public.seed_core_catalog(t.id) from public.tenants t where t.tier = 'distributor';

-- ── 4. Support plan rows: identity only, no price ──────────────────────────────────────
update public.items
   set sku         = substring(id from '^(SUP-(?:FREE|STANDARD|ENTERPRISE)-(?:MO|YR))-[0-9a-f]{32}$'),
       term_months = case when id like 'SUP-%-YR-%' then 12 else 1 end,
       fulfilment  = 'support_panel'
 where vendor = 'support'
   and sku is null
   and id ~ '^SUP-(FREE|STANDARD|ENTERPRISE)-(MO|YR)-[0-9a-f]{32}$';

-- ── 5. sync_hosting_catalog: a new hosting row starts with NO cost (0), not cost = price ──
-- From 20260901170000 (the only definition); the one change is `0` for wholesale on insert.
create or replace function public.sync_hosting_catalog(p_plans jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_plan   jsonb;
  v_planid text;
  v_id     text;
  v_msrp   integer;
  v_count  integer := 0;
begin
  if v_tenant is null then
    raise exception 'No tenant in context' using errcode = 'insufficient_privilege';
  end if;
  -- The catalogue is an owner-managed surface (same bar as editing an item).
  if not public.current_user_is_owner() then
    raise exception 'Only an owner can sync the catalogue' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_plans) is distinct from 'array' then
    raise exception 'p_plans must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  for v_plan in select * from jsonb_array_elements(p_plans)
  loop
    v_planid := nullif(trim(v_plan->>'planId'), '');
    if v_planid is null then continue; end if;  -- skip a malformed entry, don't fail the batch

    v_id   := 'HOST-' || upper(v_planid) || '-' || substr(replace(v_tenant::text, '-', ''), 1, 6);
    v_msrp := greatest(0, round(coalesce((v_plan->>'price')::numeric, 0))::int);

    insert into public.items (
      id, tenant_id, name, vendor, hsn, msrp, wholesale,
      item_type, kind, is_active, prices, synced_from_partner_id
    ) values (
      v_id, v_tenant,
      coalesce(nullif(trim(v_plan->>'name'), ''), initcap(v_planid) || ' Hosting'),
      -- R-1785: wholesale 0 = "cost not set" (/items shows "Not set"). It used to be the sale
      -- price, which read as a real cost and a 0% margin.
      'hosting', '998315', v_msrp, 0,
      'subscription', 'main', true,
      jsonb_build_object(
        'msrp',         v_msrp,
        'price_raw',    v_plan->'price',
        'renewal',      v_plan->'renewalPrice',
        'currency',     coalesce(v_plan->>'currency', 'INR'),
        'period',       coalesce(v_plan->>'period', '/mo'),
        'quotaMB',      v_plan->'quotaMB',
        'bandwidthMB',  v_plan->'bandwidthMB',
        'features',     coalesce(v_plan->'features', '[]'::jsonb),
        'popular',      coalesce((v_plan->>'popular')::boolean, false)
      ),
      v_planid
    )
    on conflict (id) do update set
      name       = excluded.name,
      vendor     = 'hosting',
      hsn        = coalesce(public.items.hsn, excluded.hsn),
      -- Auto-sync: price refreshes from the engine (Pardeep's explicit choice).
      msrp       = excluded.msrp,
      -- Cost is NOT in the public feed — keep any hand-set wholesale.
      wholesale  = public.items.wholesale,
      is_active  = true,
      prices     = excluded.prices,
      synced_from_partner_id = excluded.synced_from_partner_id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

grant execute on function public.sync_hosting_catalog(jsonb) to authenticated;

commit;
