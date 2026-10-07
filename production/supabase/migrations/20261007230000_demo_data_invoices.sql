-- deploy-peek: (exists(select 1 from pg_proc where proname='demo_data_add_invoices' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='demo_data_clear_invoices' and pronamespace='public'::regnamespace))
-- deploy-key: demodata
-- 20261007230000_demo_data_invoices
--
-- WHAT THIS CHANGES (R-361, 7 Oct 2026 — tester on staging: "one click, test data in every module")
--   The header's "+ Demo data" (api/demo-data) now fills every module. Everything goes in
--   through the person's own login (RLS) EXCEPT invoices, which have no INSERT or DELETE
--   policy on purpose (20260930176000; R-014's trg_invoices_block_delete_issued). So:
--
--     1. public.demo_data_switch — one row, OFF unless somebody turns it on. The database's
--        own "this is a test database" flag. The app already refuses demo data on live
--        (NEXT_PUBLIC_APP_ENV); this makes the database refuse too, so the two functions
--        below do nothing on live even if called straight over PostgREST.
--     2. demo_data_add_invoices(p_rows) — inserts DEMO-INV-… invoices for the caller's own
--        tenant, each for one of its "DEMO · " customers. Never touches the GST series:
--        the id is DEMO-INV-…, not next_document_number.
--     3. demo_data_clear_invoices() — deletes the caller's DEMO-INV-… invoices of
--        "DEMO · " customers, and nothing else. Uses the app.invoice_amend_reason hatch
--        that R-014's trigger honours, transaction-scoped, for exactly those rows.
--
-- BOTH functions: switch on + owner/manager + the caller's tenant (current_tenant_id()).
--
-- TURN IT ON — staging and local ONLY, never live (manager, once per database):
--     insert into public.demo_data_switch (enabled, note) values (true, 'staging test data')
--       on conflict (id) do update set enabled = true, turned_on_at = now();
-- Until then the button still fills every other module and says invoices are off.

begin;

create table if not exists public.demo_data_switch (
  id           boolean primary key default true check (id),   -- at most one row
  enabled      boolean not null default false,
  turned_on_at timestamptz not null default now(),
  note         text
);
comment on table public.demo_data_switch is
  'R-361: one row; enabled = this database accepts demo invoices (staging/local only). No row = off.';

alter table public.demo_data_switch enable row level security;
revoke all on table public.demo_data_switch from anon, authenticated;
drop policy if exists demo_data_switch_service_role on public.demo_data_switch;
create policy demo_data_switch_service_role on public.demo_data_switch
  to service_role using (true) with check (true);

-- ── The shared gate ─────────────────────────────────────────────────────────────

create or replace function public._demo_data_tenant()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if not exists (select 1 from public.demo_data_switch where enabled) then
    raise exception 'Demo invoices are switched off for this database (public.demo_data_switch).'
      using errcode = '42501';
  end if;
  if v_tenant is null or not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can add or clear demo data.'
      using errcode = '42501';
  end if;
  return v_tenant;
end $$;

revoke all on function public._demo_data_tenant() from public, anon, authenticated;

-- ── Add ─────────────────────────────────────────────────────────────────────────

create or replace function public.demo_data_add_invoices(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public._demo_data_tenant();
  v_rows    jsonb := coalesce(p_rows, '[]'::jsonb);
  r         jsonb;
  v_cust    uuid;
  v_name    text;
  v_quote   text;
  v_amount  integer;
  v_taxable integer;
  v_tax     integer;
  v_n       integer := 0;
begin
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) > 20 then
    raise exception 'Expected a list of at most 20 demo invoices.' using errcode = '22023';
  end if;

  for r in select value from jsonb_array_elements(v_rows) loop
    if not starts_with(coalesce(r->>'id', ''), 'DEMO-INV-') then
      raise exception 'A demo invoice id must start with DEMO-INV- (got %).', r->>'id' using errcode = '22023';
    end if;
    if coalesce(r->>'status', '') not in ('pending', 'paid', 'overdue') then
      raise exception 'Demo invoice % has status %; only pending, paid or overdue.', r->>'id', r->>'status' using errcode = '22023';
    end if;

    v_cust := nullif(r->>'customer_id', '')::uuid;
    select c.name into v_name from public.customers c
     where c.id = v_cust and c.tenant_id = v_tenant and starts_with(c.name, 'DEMO · ');
    if v_name is null then
      raise exception 'Demo invoice % must belong to one of your "DEMO · " customers.', r->>'id' using errcode = '22023';
    end if;

    v_quote := nullif(r->>'quote_id', '');
    if v_quote is not null and not exists (
      select 1 from public.quotes q
       where q.id = v_quote and q.tenant_id = v_tenant and starts_with(q.id, 'DEMO-Q-')
    ) then
      raise exception 'Demo invoice % may only point at a DEMO-Q- quote.', r->>'id' using errcode = '22023';
    end if;

    v_amount  := (r->>'amount')::integer;
    v_taxable := (r->>'taxable_value')::integer;
    v_tax     := (r->>'tax_amount')::integer;
    if v_amount is null or v_amount <= 0 or v_taxable is null or v_tax is null or v_taxable + v_tax <> v_amount then
      raise exception 'Demo invoice %: amount must equal taxable value + tax, in whole rupees.', r->>'id' using errcode = '22023';
    end if;

    insert into public.invoices (
      id, tenant_id, customer_id, customer_name, quote_id,
      amount, taxable_value, tax_amount, tax_rate, inter_state,
      status, invoice_date, due_date, paid_date, paid_amount, overdue_days, line_items
    ) values (
      r->>'id', v_tenant, v_cust, v_name, v_quote,
      v_amount, v_taxable, v_tax, coalesce((r->>'tax_rate')::integer, 18), coalesce((r->>'inter_state')::boolean, true),
      (r->>'status')::public.invoice_status,
      (r->>'invoice_date')::date, (r->>'due_date')::date, nullif(r->>'paid_date', '')::date,
      coalesce((r->>'paid_amount')::integer, 0), coalesce((r->>'overdue_days')::integer, 0),
      coalesce(r->'line_items', '[]'::jsonb)
    );
    v_n := v_n + 1;
  end loop;

  return v_n;
end $$;

comment on function public.demo_data_add_invoices(jsonb) is
  'R-361: inserts DEMO-INV- invoices for the caller''s own DEMO customers. Needs demo_data_switch on + owner/manager.';
revoke all on function public.demo_data_add_invoices(jsonb) from public, anon;
grant execute on function public.demo_data_add_invoices(jsonb) to authenticated;

-- ── Clear ───────────────────────────────────────────────────────────────────────

create or replace function public.demo_data_clear_invoices()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public._demo_data_tenant();
  v_n      integer;
begin
  -- The hatch R-014's trigger honours, set for this transaction only and only around rows
  -- that never took a GST number.
  perform set_config('app.invoice_amend_reason', 'R-361 demo data clear: DEMO-INV- rows of DEMO customers', true);

  delete from public.invoices i
   where i.tenant_id = v_tenant
     and starts_with(i.id, 'DEMO-INV-')
     and starts_with(i.customer_name, 'DEMO · ');
  get diagnostics v_n = row_count;

  perform set_config('app.invoice_amend_reason', '', true);
  return v_n;
end $$;

comment on function public.demo_data_clear_invoices() is
  'R-361: deletes the caller''s DEMO-INV- invoices of DEMO customers only. Needs demo_data_switch on + owner/manager.';
revoke all on function public.demo_data_clear_invoices() from public, anon;
grant execute on function public.demo_data_clear_invoices() to authenticated;

commit;
