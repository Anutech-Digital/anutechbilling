-- deploy-key: invlinecosts
-- deploy-peek: exists(select 1 from pg_trigger where tgname='trg_invoice_copy_quote_lines') and exists(select 1 from pg_proc where proname='invoice_cost_fill_apply' and pronamespace='public'::regnamespace)
-- 20261009180000_invoice_line_costs  (R-487)
--
-- WHAT WAS WRONG
--   /invoices "Margin MTD" read "Cost missing on 11 lines" for ANUTECH (local, 9 Oct) —
--   every invoice this month. Not one line had a cost because not one invoice had LINES:
--   generate_invoice() (the quote → invoice path that record_payment / "Generate invoice"
--   use) inserts amount, tax and advances but never `line_items`, so invoices.line_items
--   stayed NULL. The quote's lines — with their cost — never reached the invoice, and
--   margin-mtd.ts counts a line-less invoice as wholly uncosted.
--   (Measured: 42 of 50 local invoices have NULL line_items; the 8 with lines are
--   subscription instalments / project milestones / demo rows that write their own.)
--
-- THE FIX
--   1. invoice_line_catalog_cost(tenant, line) — the catalogue's cost for one line, in the
--      line's stored unit (₹/seat/YEAR for annual commitments, ₹/seat/MONTH for flex), the
--      same rule as quote-builder's late-catalogue fill (R-388): by item_id, else by an
--      exact (unique) catalogue name ignoring "(annual)" / "·" decorations; slab band when exactly one covers qty, else the flat
--      tier. NULL when the catalogue cannot answer — never a made-up 0.
--   2. invoice_lines_with_costs(tenant, lines, null_unknown) — keeps every known cost,
--      fills unknown ones from the catalogue, and (when copying from a quote) stores an
--      unknown cost as NULL instead of the quote's 0, so "missing" never reads as "free".
--      Own-service (SUP-…) lines and ₹0 lines are left exactly as they are.
--   3. BEFORE INSERT trigger on invoices: an invoice created for a quote with no lines of
--      its own gets the quote's lines (costs as above). Paths that write their own lines
--      (instalments, milestones, demo data) are untouched — the trigger only acts on NULL.
--   4. Existing invoices are NOT changed by this migration. The owner gets a preview-first
--      action: invoice_cost_fill_preview() lists what would be filled; invoice_cost_fill_apply
--      (ids) writes only the cost of lines — amount, taxable value, tax, rate, qty and the
--      printed lines (PDF prefers the quote's lines) do not move. NULL line_items may be
--      filled once by design (tg_invoices_freeze_issued "once-set"); filling a cost inside
--      lines that already exist is done under app.invoice_amend_reason, transaction-local,
--      with the reason logged. Invoices in a books-locked period are skipped and reported.
--
-- Money is whole rupees (AGENTS.md §1). Grants: authenticated for the two owner RPCs only;
-- the helpers are definer-internal (service_role only), never anon.

-- ── 1. catalogue cost of one line ─────────────────────────────────────────────
create or replace function public.invoice_line_catalog_cost(p_tenant uuid, p_line jsonb)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item     public.items;
  v_name     text;
  v_hits     integer;
  v_qty      numeric;
  v_annual   boolean;
  v_tier     jsonb;
  v_pm       numeric;
  v_slab     jsonb;
begin
  if p_tenant is null or jsonb_typeof(p_line) is distinct from 'object' then return null; end if;

  if nullif(btrim(coalesce(p_line->>'item_id', '')), '') is not null then
    select * into v_item from public.items i where i.tenant_id = p_tenant and i.id = p_line->>'item_id';
  end if;

  if v_item.id is null then
    -- Name key: lower-case, decorations dropped ("Google Workspace · Business Starter (annual)"
    -- → "google workspace business starter"), spaces collapsed. Exact and unique, never fuzzy.
    v_name := btrim(regexp_replace(regexp_replace(lower(coalesce(p_line->>'name', '')), '\([^)]*\)|[·•]', ' ', 'g'), '\s+', ' ', 'g'));
    if v_name <> '' then
      select count(*) into v_hits from public.items i
       where i.tenant_id = p_tenant
         and btrim(regexp_replace(regexp_replace(lower(coalesce(i.name, '')), '\([^)]*\)|[·•]', ' ', 'g'), '\s+', ' ', 'g')) = v_name;
      if v_hits = 1 then
        select * into v_item from public.items i
         where i.tenant_id = p_tenant
           and btrim(regexp_replace(regexp_replace(lower(coalesce(i.name, '')), '\([^)]*\)|[·•]', ' ', 'g'), '\s+', ' ', 'g')) = v_name;
      end if;
    end if;
  end if;

  if v_item.id is null then return null; end if;

  v_qty    := case when jsonb_typeof(p_line->'qty') = 'number' then (p_line->>'qty')::numeric else 1 end;
  v_annual := coalesce(p_line->>'commitment', 'annual_yearly') <> 'monthly';

  if v_annual then
    -- volume-tiers.ts slabPricing: the band covering qty, else the flat tier.
    if jsonb_typeof(v_item.prices->'slabs') = 'array' then
      select count(*) into v_hits from jsonb_array_elements(v_item.prices->'slabs') s
       where jsonb_typeof(s->'minSeats') = 'number' and (s->>'minSeats')::numeric <= v_qty
         and (jsonb_typeof(s->'maxSeats') is distinct from 'number' or v_qty <= (s->>'maxSeats')::numeric);
      if v_hits = 1 then
        select s into v_slab from jsonb_array_elements(v_item.prices->'slabs') s
         where jsonb_typeof(s->'minSeats') = 'number' and (s->>'minSeats')::numeric <= v_qty
           and (jsonb_typeof(s->'maxSeats') is distinct from 'number' or v_qty <= (s->>'maxSeats')::numeric);
        if jsonb_typeof(v_slab->'wholesale') = 'number' then v_pm := (v_slab->>'wholesale')::numeric; end if;
      end if;
    end if;
    if v_pm is null then
      v_tier := coalesce(v_item.prices->'annual', v_item.prices->'monthly');
      if jsonb_typeof(v_tier->'msrp') = 'number' and (v_tier->>'msrp')::numeric > 0
         and jsonb_typeof(v_tier->'wholesale') = 'number' then
        v_pm := (v_tier->>'wholesale')::numeric;
      else
        v_pm := v_item.wholesale;
      end if;
    end if;
  else
    v_pm := case when jsonb_typeof(v_item.prices->'monthly'->'wholesale') = 'number'
                 then (v_item.prices->'monthly'->>'wholesale')::numeric else v_item.wholesale end;
  end if;

  if v_pm is null or v_pm <= 0 then return null; end if;
  return round(case when v_annual then v_pm * 12 else v_pm end)::integer;
end;
$$;

revoke all on function public.invoice_line_catalog_cost(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.invoice_line_catalog_cost(uuid, jsonb) to service_role;

-- ── 2. lines with known / catalogue / NULL cost ───────────────────────────────
create or replace function public.invoice_lines_with_costs(p_tenant uuid, p_lines jsonb, p_null_unknown boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out  jsonb := '[]'::jsonb;
  v_line jsonb;
  v_rate numeric;
  v_cost numeric;
  v_cat  integer;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then return p_lines; end if;
  for v_line in select e from jsonb_array_elements(p_lines) e loop
    if jsonb_typeof(v_line) = 'object' then
      v_rate := case when jsonb_typeof(v_line->'rate') = 'number' then (v_line->>'rate')::numeric else 0 end;
      v_cost := case when jsonb_typeof(v_line->'cost') = 'number' then (v_line->>'cost')::numeric else null end;
      -- lib/quotes/line-cost.ts lineCostUnknown: priced, not our own SUP- service, cost null or <= 0.
      if v_rate > 0 and coalesce(v_line->>'item_id', '') not like 'SUP-%' and (v_cost is null or v_cost <= 0) then
        v_cat := public.invoice_line_catalog_cost(p_tenant, v_line);
        if v_cat is not null then
          v_line := v_line || jsonb_build_object('cost', v_cat, 'cost_source', 'catalog');
        elsif p_null_unknown then
          v_line := v_line || jsonb_build_object('cost', null);
        end if;
      end if;
    end if;
    v_out := v_out || jsonb_build_array(v_line);
  end loop;
  return v_out;
end;
$$;

revoke all on function public.invoice_lines_with_costs(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.invoice_lines_with_costs(uuid, jsonb, boolean) to service_role;

-- ── 3. new invoices copy the quote's lines ────────────────────────────────────
create or replace function public.tg_invoice_copy_quote_lines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lines jsonb;
begin
  if new.line_items is not null or new.quote_id is null then return new; end if;
  select q.line_items into v_lines from public.quotes q
   where q.id = new.quote_id and q.tenant_id = new.tenant_id;
  if jsonb_typeof(v_lines) = 'array' and jsonb_array_length(v_lines) > 0 then
    new.line_items := public.invoice_lines_with_costs(new.tenant_id, v_lines, true);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_invoice_copy_quote_lines on public.invoices;
create trigger trg_invoice_copy_quote_lines
  before insert on public.invoices
  for each row execute function public.tg_invoice_copy_quote_lines();

-- ── 4a. owner preview: what "Fill missing costs" would write ──────────────────
create or replace function public.invoice_cost_fill_preview()
returns table (
  invoice_id    text,
  invoice_date  date,
  customer_name text,
  line_index    integer,
  line_name     text,
  qty           numeric,
  rate          numeric,
  cost_new      integer,
  source        text,
  blocked       text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_lock   date;
  r        record;
  v_base   jsonb;
  v_filled jsonb;
  v_from_quote boolean;
  i        integer;
  v_old    jsonb;
  v_new    jsonb;
  v_rate   numeric;
  v_oc     numeric;
begin
  if v_tenant is null or not public.current_user_is_owner() then
    raise exception 'Only the owner can fill missing invoice costs. Ask the owner to open Invoices → Margin MTD → Fill missing costs.'
      using errcode = 'insufficient_privilege';
  end if;
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  for r in
    select inv.id, inv.invoice_date, inv.customer_name, inv.line_items, q.line_items as q_lines
      from public.invoices inv
      left join public.quotes q on q.id = inv.quote_id and q.tenant_id = inv.tenant_id
     where inv.tenant_id = v_tenant and inv.status::text <> 'void'
     order by inv.invoice_date desc, inv.id
  loop
    v_from_quote := r.line_items is null;
    v_base := case when v_from_quote then r.q_lines else r.line_items end;
    if jsonb_typeof(v_base) is distinct from 'array' or jsonb_array_length(v_base) = 0 then continue; end if;
    v_filled := public.invoice_lines_with_costs(v_tenant, v_base, v_from_quote);

    for i in 0 .. jsonb_array_length(v_base) - 1 loop
      v_old  := v_base -> i;
      v_new  := v_filled -> i;
      if jsonb_typeof(v_old) is distinct from 'object' then continue; end if;
      v_rate := case when jsonb_typeof(v_old->'rate') = 'number' then (v_old->>'rate')::numeric else 0 end;
      if v_rate <= 0 or coalesce(v_old->>'item_id', '') like 'SUP-%' then continue; end if;
      v_oc   := case when jsonb_typeof(v_old->'cost') = 'number' then (v_old->>'cost')::numeric else null end;
      -- An invoice that already has lines with a known cost has nothing to do on that line.
      if not v_from_quote and v_oc is not null and v_oc > 0 then continue; end if;

      invoice_id    := r.id;
      invoice_date  := r.invoice_date;
      customer_name := r.customer_name;
      line_index    := i;
      line_name     := v_old->>'name';
      qty           := case when jsonb_typeof(v_old->'qty') = 'number' then (v_old->>'qty')::numeric else null end;
      rate          := v_rate;
      cost_new      := case when jsonb_typeof(v_new->'cost') = 'number' then round((v_new->>'cost')::numeric)::integer else null end;
      source        := case when cost_new is null then 'missing'
                            when v_new->>'cost_source' = 'catalog' and v_new is distinct from v_old then 'catalog'
                            else 'quote' end;
      blocked       := case when v_lock is not null and r.invoice_date <= v_lock then 'books_locked' else null end;
      return next;
    end loop;
  end loop;
end;
$$;

revoke all on function public.invoice_cost_fill_preview() from public, anon;
grant execute on function public.invoice_cost_fill_preview() to authenticated, service_role;

-- ── 4b. owner apply: write the costs the preview showed ───────────────────────
create or replace function public.invoice_cost_fill_apply(p_invoice_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_lock    date;
  r         record;
  v_new     jsonb;
  v_updated integer := 0;
  v_locked  integer := 0;
  v_costed  integer := 0;
begin
  if v_tenant is null or not public.current_user_is_owner() then
    raise exception 'Only the owner can fill missing invoice costs. Ask the owner to open Invoices → Margin MTD → Fill missing costs.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_invoice_ids is null or cardinality(p_invoice_ids) = 0 then
    return jsonb_build_object('invoices_updated', 0, 'lines_costed', 0, 'skipped_locked', 0);
  end if;
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  for r in
    select inv.id, inv.invoice_date, inv.line_items, q.line_items as q_lines
      from public.invoices inv
      left join public.quotes q on q.id = inv.quote_id and q.tenant_id = inv.tenant_id
     where inv.tenant_id = v_tenant and inv.status::text <> 'void' and inv.id = any(p_invoice_ids)
     for update of inv
  loop
    if v_lock is not null and r.invoice_date <= v_lock then v_locked := v_locked + 1; continue; end if;

    if r.line_items is null then
      if jsonb_typeof(r.q_lines) is distinct from 'array' or jsonb_array_length(r.q_lines) = 0 then continue; end if;
      v_new := public.invoice_lines_with_costs(v_tenant, r.q_lines, true);
      -- NULL → lines is a once-set fill (tg_invoices_freeze_issued); no amend reason needed.
      update public.invoices set line_items = v_new where id = r.id and tenant_id = v_tenant and line_items is null;
    else
      if jsonb_typeof(r.line_items) is distinct from 'array' then continue; end if;
      v_new := public.invoice_lines_with_costs(v_tenant, r.line_items, false);
      if v_new is not distinct from r.line_items then continue; end if;
      -- Only the internal `cost` / `cost_source` keys differ; nothing printed or taxed moves.
      perform set_config('app.invoice_amend_reason', 'R-487 fill missing internal line cost from catalogue (owner confirmed)', true);
      update public.invoices set line_items = v_new where id = r.id and tenant_id = v_tenant;
      perform set_config('app.invoice_amend_reason', '', true);
    end if;

    v_updated := v_updated + 1;
    select v_costed + count(*) into v_costed from jsonb_array_elements(v_new) e
     where jsonb_typeof(e->'cost') = 'number' and (e->>'cost')::numeric > 0;
  end loop;

  return jsonb_build_object('invoices_updated', v_updated, 'lines_costed', v_costed, 'skipped_locked', v_locked);
end;
$$;

revoke all on function public.invoice_cost_fill_apply(text[]) from public, anon;
grant execute on function public.invoice_cost_fill_apply(text[]) to authenticated, service_role;
