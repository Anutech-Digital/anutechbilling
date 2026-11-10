-- deploy-peek: to_regclass('public.zoho_account_category_map') is not null and to_regclass('public.zoho_vendor_payment_links') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'zoho_doc_id') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendor_bills' and column_name = 'zoho_doc_id') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendors' and column_name = 'zoho_contact_id') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_purchases(text,text,jsonb,boolean)') and prosrc like '%R-2502%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_vendor_payments(text,jsonb,boolean)') and prosrc like '%R-2502%') and to_regprocedure('public.remove_zoho_fy_purchase_import(uuid,text)') is not null and to_regprocedure('public.save_zoho_account_categories(jsonb)') is not null and exists(select 1 from pg_trigger where tgname = 'trg_expenses_zoho_doc_guard') and to_regprocedure('public._r2502_leg_head(text,integer,boolean,jsonb,jsonb)') is not null
-- deploy-key: r2502zohofypurchases
--
-- R-2502 (goal G-FY2526, owner decision D4, 5 Nov 2026): Excel's FY 2025-26 purchases come in from
-- Zoho Books — bills, expenses and vendor payments — into the app's EXISTING tables, so the P&L, ITC
-- (GSTR-3B), TDS payable, payables and the vendor statement count them with the formulas they already
-- use (no new formula). Built on R-2499's generic FY framework (zoho_fy_scan, zoho_fy_import_batches —
-- migration 20261105140500): the money is read from the server's own scan (whole rupees, normalised in
-- lib/integrations/zoho-books/purchase-import/normalise.ts), never from the browser.
--
-- ══ WHAT THIS ADDS ═════════════════════════════════════════════════════════════════════════════
--   1. zoho_account_category_map — per company: Zoho account → app category (the mapping screen).
--      Owner / accountant write it through save_zoho_account_categories(); a Zoho account with no
--      row lands in "Unmapped — review" (safe default; the preview lists them).
--   2. vendors.zoho_contact_id; vendor_bills.zoho_doc_id + purchase_import_batch_id;
--      expenses.zoho_doc_id + zoho_leg + purchase_import_batch_id. zoho_doc_id = '<kind>:<Zoho id>'
--      ('bills:…' / 'expenses:…'), unique per company (and per leg on expenses) → a rerun never makes
--      a second copy.
--   3. import_zoho_fy_purchases(kind, fy, picks, dry_run) — OWNER / ACCOUNTANT. picks = Zoho id + the
--      vendor the preview matched (null = create it from Zoho). Per document:
--        all lines COGS-* → ONE vendor_bills row (unpaid; TDS goes with its first payment, as on the
--        Bills page); otherwise one expenses row per category (unpaid bill for a Zoho bill; paid — no
--        bank line yet — for a Zoho expense: Reconcile's "recorded payment" match banks it on the 4523
--        debit, R-1911). Claimable GST in gst_paid (heads when one category), Zoho's ineligible ITC
--        stays in the cost, RCM → rcm + rcm_tax, TDS (Zoho's section) on the first row.
--      Left out with the reason: void / draft, a normaliser problem, outside the FY, no books start /
--      before it (books_start_for, R-2496), inside the books lock, COGS + expense lines mixed, the
--      same vendor + bill number already in the books (entered by hand), any trigger refusal.
--      dry_run (default) = the same inserts in a block that is rolled back.
--   4. import_zoho_fy_vendor_payments(fy, picks, dry_run) — a Zoho payment onto the bills imported
--      above: a COGS bill through pay_vendor_bill (manual bank line on the account the owner picked,
--      matched later to the real 4523 debit — R-1911; the bill's Zoho TDS with its first payment); an
--      expense bill is marked paid (no bank line — the Expenses → Mark paid state) once Zoho's payments
--      + TDS cover it; a part payment is recorded and reported. Advances (unapplied) are reported.
--      zoho_vendor_payment_links keeps each application (and what it changed) for undo.
--   5. remove_zoho_fy_purchase_import(batch, reason) — takes one batch back while untouched.
--   Every part writes one zoho_fy_import_batches row + one activity_log row.
--
-- Cloud SQL: no extensions schema; auth.uid() rewritten by the deploy script. Grants explicit.
-- Test: supabase/tests/r2502_zoho_fy_purchase_import.test.sql (rolled back).
-- Rollback: drop the four functions and two tables; drop the added columns (after removing batches).

begin;

-- ── 1. Zoho account → app category, per company ──────────────────────────────────────────────
create table if not exists public.zoho_account_category_map (
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,
  zoho_account_id   text        not null check (char_length(zoho_account_id) between 1 and 40),
  zoho_account_name text        not null default '' check (char_length(zoho_account_name) <= 200),
  category          text        not null check (char_length(btrim(category)) between 2 and 60 and category <> 'Salaries'),
  updated_by        uuid        references public.users(id) on delete set null,
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, zoho_account_id)
);
comment on table public.zoho_account_category_map is
  'R-2502: Zoho Books account → app expense / COGS category, per company. Written only by save_zoho_account_categories(); read by the FY purchase import.';
alter table public.zoho_account_category_map enable row level security;
revoke all on table public.zoho_account_category_map from public, anon, authenticated;
grant select on table public.zoho_account_category_map to authenticated;
grant all on table public.zoho_account_category_map to service_role;
drop policy if exists zoho_account_category_map_select on public.zoho_account_category_map;
create policy zoho_account_category_map_select on public.zoho_account_category_map as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));
drop policy if exists zzz_service_role_all on public.zoho_account_category_map;
create policy zzz_service_role_all on public.zoho_account_category_map as permissive for all to service_role using (true) with check (true);

-- ── 2. Zoho ids on the app's own tables ──────────────────────────────────────────────────────
alter table public.vendors add column if not exists zoho_contact_id text;
create unique index if not exists vendors_tenant_zoho_contact_uq on public.vendors (tenant_id, zoho_contact_id) where zoho_contact_id is not null;
comment on column public.vendors.zoho_contact_id is 'R-2502: the Zoho Books vendor (contact_id) this vendor was matched to or created from by the FY purchase import.';

alter table public.vendor_bills add column if not exists zoho_doc_id text;
alter table public.vendor_bills add column if not exists purchase_import_batch_id uuid references public.zoho_fy_import_batches(id) on delete restrict;
create unique index if not exists vendor_bills_tenant_zoho_doc_uq on public.vendor_bills (tenant_id, zoho_doc_id) where zoho_doc_id is not null;
create index if not exists vendor_bills_purchase_import_batch_idx on public.vendor_bills (purchase_import_batch_id) where purchase_import_batch_id is not null;
comment on column public.vendor_bills.zoho_doc_id is 'R-2502: ''bills:<Zoho bill_id>'' of a COGS bill imported from Zoho (unique per company). NULL otherwise.';

alter table public.expenses add column if not exists zoho_doc_id text;
alter table public.expenses add column if not exists zoho_leg smallint;
alter table public.expenses add column if not exists purchase_import_batch_id uuid references public.zoho_fy_import_batches(id) on delete restrict;
create unique index if not exists expenses_tenant_zoho_doc_leg_uq on public.expenses (tenant_id, zoho_doc_id, zoho_leg) where zoho_doc_id is not null;
create index if not exists expenses_purchase_import_batch_idx on public.expenses (purchase_import_batch_id) where purchase_import_batch_id is not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'expenses_zoho_doc_shape') then
    alter table public.expenses add constraint expenses_zoho_doc_shape check (
      (zoho_doc_id is null) = (zoho_leg is null) and (zoho_doc_id is null) = (purchase_import_batch_id is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vendor_bills_zoho_doc_shape') then
    alter table public.vendor_bills add constraint vendor_bills_zoho_doc_shape check ((zoho_doc_id is null) = (purchase_import_batch_id is null));
  end if;
end $$;
comment on column public.expenses.zoho_doc_id is 'R-2502: ''bills:<id>'' / ''expenses:<id>'' of the Zoho document this row came from (zoho_leg = its category part). NULL otherwise.';

-- ── 3. Vendor payment applications (for undo and "already") ──────────────────────────────────
create table if not exists public.zoho_vendor_payment_links (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  batch_id        uuid        not null references public.zoho_fy_import_batches(id) on delete restrict,
  zoho_payment_id text        not null check (char_length(zoho_payment_id) between 1 and 40),
  zoho_bill_id    text        not null check (char_length(zoho_bill_id) between 1 and 40),
  target_type     text        not null check (target_type in ('vendor_bill', 'expense')),
  target_ids      text[]      not null,
  amount          integer     not null check (amount > 0),
  tds_amount      integer     not null default 0 check (tds_amount >= 0),
  bank_txn_id     uuid,
  settled         boolean     not null default false,
  prev            jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (tenant_id, zoho_payment_id, zoho_bill_id)
);
comment on table public.zoho_vendor_payment_links is
  'R-2502: one row per Zoho vendor payment applied to an imported bill — what it changed (prev) so remove_zoho_fy_purchase_import can take it back. Written only by the import functions.';
create index if not exists zoho_vendor_payment_links_bill_idx on public.zoho_vendor_payment_links (tenant_id, zoho_bill_id);
create index if not exists zoho_vendor_payment_links_batch_idx on public.zoho_vendor_payment_links (batch_id);
alter table public.zoho_vendor_payment_links enable row level security;
revoke all on table public.zoho_vendor_payment_links from public, anon, authenticated;
grant select on table public.zoho_vendor_payment_links to authenticated;
grant all on table public.zoho_vendor_payment_links to service_role;
drop policy if exists zoho_vendor_payment_links_select on public.zoho_vendor_payment_links;
create policy zoho_vendor_payment_links_select on public.zoho_vendor_payment_links as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));
drop policy if exists zzz_service_role_all on public.zoho_vendor_payment_links;
create policy zzz_service_role_all on public.zoho_vendor_payment_links as permissive for all to service_role using (true) with check (true);

-- ── 4. Save the mapping ──────────────────────────────────────────────────────────────────────
create or replace function public.save_zoho_account_categories(p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 */
  v_tenant uuid := public.current_tenant_id();
  r        jsonb;
  v_id     text;
  v_cat    text;
  v_set    integer := 0;
  v_clear  integer := 0;
begin
  if v_tenant is null then
    raise exception 'Saving the account map needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can map Zoho accounts.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Send at most 500 accounts.' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_id  := btrim(coalesce(r->>'zoho_account_id', ''));
    v_cat := btrim(coalesce(r->>'category', ''));
    if v_id = '' or char_length(v_id) > 40 then
      raise exception 'A Zoho account id is missing.' using errcode = '22023';
    end if;
    if v_cat = '' then
      delete from public.zoho_account_category_map where tenant_id = v_tenant and zoho_account_id = v_id;
      v_clear := v_clear + 1;
      continue;
    end if;
    if v_cat = 'Salaries' then
      raise exception 'Salaries are booked by Payroll — map this account to another category.' using errcode = '22023';
    end if;
    if char_length(v_cat) not between 2 and 60 then
      raise exception 'Category "%" is not a category.', v_cat using errcode = '22023';
    end if;
    insert into public.zoho_account_category_map (tenant_id, zoho_account_id, zoho_account_name, category, updated_by, updated_at)
    values (v_tenant, v_id, left(btrim(coalesce(r->>'zoho_account_name', '')), 200), v_cat, auth.uid(), now())
    on conflict (tenant_id, zoho_account_id) do update
      set category = excluded.category, zoho_account_name = excluded.zoho_account_name, updated_by = excluded.updated_by, updated_at = now();
    v_set := v_set + 1;
  end loop;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_account_map.saved', 'zoho_account_category_map', null,
          left(format('Zoho account map: %s set, %s cleared', v_set, v_clear), 120), jsonb_build_object('rows', p_rows));
  return jsonb_build_object('saved', v_set, 'cleared', v_clear);
end;
$function$;
revoke all on function public.save_zoho_account_categories(jsonb) from public, anon;
grant execute on function public.save_zoho_account_categories(jsonb) to authenticated, service_role;

-- ── 4b. The GST head of one expense row (same rule as purchase-import/plan.ts legsOf) ────────
-- One row with all GST claimable → the document's own heads. Otherwise the row's claimable GST
-- (gst) under the document's head: IGST, or CGST + SGST halves. Both kinds on one document, or
-- reverse charge → NULL (the report says "assumed").
create or replace function public._r2502_leg_head(p_head text, p_n_legs integer, p_rcm boolean, p_leg jsonb, p_doc jsonb)
returns integer
language sql
immutable
set search_path to 'public'
as $function$
  /* R-2502 */
  select case
    when p_rcm then null
    when p_n_legs = 1 and coalesce((p_leg->>'cost_gst')::integer, 0) = 0 then (p_doc->>p_head)::integer
    when coalesce((p_doc->>'igst')::integer, 0) > 0 and coalesce((p_doc->>'cgst')::integer, 0) + coalesce((p_doc->>'sgst')::integer, 0) = 0 then
      case p_head when 'igst' then (p_leg->>'gst')::integer else 0 end
    when coalesce((p_doc->>'igst')::integer, 0) = 0 then
      case p_head when 'igst' then 0
                  when 'cgst' then round((p_leg->>'gst')::integer / 2.0)::integer
                  else (p_leg->>'gst')::integer - round((p_leg->>'gst')::integer / 2.0)::integer end
    else null
  end;
$function$;
revoke all on function public._r2502_leg_head(text, integer, boolean, jsonb, jsonb) from public, anon;
grant execute on function public._r2502_leg_head(text, integer, boolean, jsonb, jsonb) to authenticated, service_role;

-- ── 5. Import bills / expenses (and dry run) ─────────────────────────────────────────────────
create or replace function public.import_zoho_fy_purchases(p_kind text, p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 */
  v_tenant   uuid := public.current_tenant_id();
  v_start    date;
  v_lock     date;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_zid      text;
  v_key      text;
  v_num      text;
  v_date     date;
  v_due      date;
  v_status   text;
  v_reason   text;
  v_vendor   public.vendors;
  v_gstin    text;
  v_valid_g  boolean;
  v_legs     jsonb;
  v_leg      jsonb;
  v_n_legs   integer;
  v_cogs     integer;
  v_cost     integer;
  v_rcm      boolean;
  v_tds      integer;
  v_tsec     text;
  v_taxable  integer;
  v_tax      integer;
  v_amount   integer;
  v_i        integer;
  v_ids      text[];
  v_hash     text;
  v_new_v    integer := 0;
  v_seen     text[] := array[]::text[];
  v_done     jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_n        integer := 0;
  v_sum_tx   bigint := 0;
  v_sum_tax  bigint := 0;
  v_sum_amt  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing purchases needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY purchases from Zoho. Ask one of them.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('bills', 'expenses') then
    raise exception 'Choose bills or expenses.' using errcode = '22023';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$' or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There is nothing to import. Read from Zoho again and preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many documents in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;

  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  /* One block: a dry run raises R2502 at the end, so the batch, every row, every vendor made and
     every trigger's work roll back — the preview ran the real thing. */
  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, p_kind, p_fy, auth.uid())
  returning id into v_batch;
  /* Only this import may write the Zoho id / batch on expenses and vendor_bills (tg_purchases_zoho_doc_guard). */
  perform set_config('app.zoho_purchase_import', 'on', true);

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_id', ''));
    v_key := p_kind || ':' || v_zid;
    v_reason := null;
    v_scan := null;
    v_num := v_zid;

    if v_zid = '' or v_zid = any (v_seen) then
      v_reason := 'Listed twice or with no Zoho id.';
    else
      v_seen := v_seen || v_zid;
      select * into v_scan from public.zoho_fy_scan s
       where s.tenant_id = v_tenant and s.kind = p_kind and s.zoho_id = v_zid and s.fy = p_fy;
      if not found or v_scan.payload is null then
        v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.';
      end if;
    end if;

    if v_reason is null then
      v_p      := v_scan.payload;
      v_num    := btrim(coalesce(v_p->>'number', ''));
      v_status := lower(coalesce(v_p->>'status', ''));
      v_rcm    := coalesce((v_p->>'rcm')::boolean, false);
      begin
        v_date := (v_p->>'date')::date;
        v_due  := nullif(v_p->>'dueDate', '')::date;
        v_tds  := coalesce((v_p->>'tdsAmount')::integer, 0);
      exception when others then
        v_reason := 'Its date or amounts could not be read — read it from Zoho again.';
      end;
      v_tsec := nullif(v_p->>'tdsSection', '');
    end if;

    if v_reason is null then
      if v_status = 'void' then v_reason := 'Void in Zoho — not a purchase, not in the P&L or ITC.';
      elsif v_status = 'draft' then v_reason := 'Draft in Zoho — never booked there.';
      elsif jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then
        v_reason := v_p->'problems'->>0;
      elsif char_length(v_num) > 60 then v_reason := 'The Zoho number is longer than 60 characters.';
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then
        v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then
        v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then
        v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then
        v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif v_tds < 0 or (v_tds > 0 and v_tsec is null) then
        v_reason := 'Its TDS has no section.';
      end if;
    end if;

    -- Already here (same Zoho id) → already (a rerun).
    if v_reason is null then
      if exists (select 1 from public.expenses e where e.tenant_id = v_tenant and e.zoho_doc_id = v_key)
         or exists (select 1 from public.vendor_bills b where b.tenant_id = v_tenant and b.zoho_doc_id = v_key) then
        v_already := v_already + 1;
        continue;
      end if;
    end if;

    -- Legs: one per category (the company's map; unmapped → "Unmapped — review"), first-seen order.
    if v_reason is null then
      select coalesce(jsonb_agg(jsonb_build_object(
               'category', g.category, 'taxable', g.taxable, 'gst', g.gst, 'cost_gst', g.cost_gst, 'rcm_tax', g.rcm_tax,
               'lines', g.lines) order by g.first_ord), '[]'::jsonb)
        into v_legs
        from (
          select c.category,
                 sum(coalesce((x.l->>'taxable')::integer, 0)) as taxable,
                 sum(case when not v_rcm and coalesce((x.l->>'itcEligible')::boolean, true) then coalesce((x.l->>'tax')::integer, 0) else 0 end) as gst,
                 sum(case when not v_rcm and not coalesce((x.l->>'itcEligible')::boolean, true) then coalesce((x.l->>'tax')::integer, 0) else 0 end) as cost_gst,
                 sum(case when v_rcm then coalesce((x.l->>'tax')::integer, 0) else 0 end) as rcm_tax,
                 min(x.ord) as first_ord,
                 jsonb_agg(x.l order by x.ord) as lines
            from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) with ordinality x(l, ord)
            left join public.zoho_account_category_map m
              on m.tenant_id = v_tenant and m.zoho_account_id = coalesce(x.l->>'accountId', '')
            cross join lateral (select coalesce(m.category, 'Unmapped — review') as category) c
           group by c.category
        ) g;
      v_n_legs := jsonb_array_length(v_legs);
      select count(*) filter (where (l->>'category') like 'COGS-%'), coalesce(sum((l->>'cost_gst')::integer), 0)
        into v_cogs, v_cost from jsonb_array_elements(v_legs) l;
      if v_n_legs = 0 then v_reason := 'It has no lines or account in Zoho.';
      elsif v_cogs > 0 and v_cogs < v_n_legs then v_reason := 'It has COGS and expense lines — add it by hand, or map its accounts to one kind.';
      elsif v_cogs > 0 and p_kind = 'expenses' then v_reason := 'A Zoho expense on a COGS account — add it as a COGS bill by hand.';
      elsif v_cogs > 0 and v_rcm then v_reason := 'A COGS bill under reverse charge — add it by hand.';
      elsif v_cogs > 0 and v_cost > 0 then v_reason := 'A COGS bill with ineligible ITC — add it by hand.';
      end if;
    end if;

    -- Vendor: the preview's pick (this company's), else Zoho contact id → GSTIN → the one vendor with
    -- that exact name, else create it from Zoho. Its own block: a refusal here (a bad id, two tabs
    -- creating the same vendor) leaves THIS document out, never the whole part.
    if v_reason is null then
      v_vendor := null;
      v_gstin := upper(regexp_replace(coalesce(v_p->>'gstin', ''), '[\s.\-]+', '', 'g'));
      v_valid_g := v_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$';
      begin
        if nullif(v_pick->>'vendor_id', '') is not null then
          if (v_pick->>'vendor_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            v_reason := 'The vendor picked is not in your company — preview again.';
          else
            select * into v_vendor from public.vendors v where v.id = (v_pick->>'vendor_id')::uuid and v.tenant_id = v_tenant;
            if not found then v_reason := 'The vendor picked is not in your company — preview again.'; end if;
          end if;
        else
          select * into v_vendor from public.vendors v
           where v.tenant_id = v_tenant and v.zoho_contact_id = nullif(v_p->>'vendorZohoId', '');
          if not found and v_valid_g then
            select * into v_vendor from public.vendors v
             where v.tenant_id = v_tenant and upper(regexp_replace(coalesce(v.gstin, ''), '[\s.\-]+', '', 'g')) = v_gstin
             order by v.created_at limit 1;
          end if;
          if v_vendor.id is null and (select count(*) from public.vendors v where v.tenant_id = v_tenant
                                        and lower(btrim(v.name)) = lower(btrim(coalesce(v_p->>'vendorName', '')))) = 1 then
            select * into v_vendor from public.vendors v
             where v.tenant_id = v_tenant and lower(btrim(v.name)) = lower(btrim(coalesce(v_p->>'vendorName', '')));
          end if;
          if v_vendor.id is null then
            if btrim(coalesce(v_p->>'vendorName', '')) = '' then
              v_reason := 'It has no vendor in Zoho.';
            else
              insert into public.vendors (tenant_id, name, gstin, zoho_contact_id, notes)
              values (v_tenant, left(btrim(v_p->>'vendorName'), 200), case when v_valid_g then v_gstin end,
                      nullif(v_p->>'vendorZohoId', ''), 'Created from Zoho Books by the FY purchase import.')
              returning * into v_vendor;
              v_new_v := v_new_v + 1;
            end if;
          end if;
        end if;
        if v_reason is null and v_vendor.zoho_contact_id is null and nullif(v_p->>'vendorZohoId', '') is not null
           and not exists (select 1 from public.vendors v where v.tenant_id = v_tenant and v.zoho_contact_id = v_p->>'vendorZohoId') then
          update public.vendors set zoho_contact_id = v_p->>'vendorZohoId' where id = v_vendor.id returning * into v_vendor;
        end if;
        /* A vendor typed by hand without its GSTIN: the ITC rule reads the GSTIN from the vendor
           master (lib/gst/itc.ts), so Zoho's GSTIN is copied there — else the credit Zoho claimed
           would silently become a cost. Never overwrites a GSTIN already saved. */
        if v_reason is null and v_valid_g and coalesce(btrim(v_vendor.gstin), '') = '' then
          update public.vendors set gstin = v_gstin where id = v_vendor.id returning * into v_vendor;
        end if;
      exception when others then
        v_reason := sqlerrm;
      end;
    end if;

    -- Entered by hand already (same vendor + bill number)?
    if v_reason is null and v_num <> '' then
      if exists (select 1 from public.expenses e where e.tenant_id = v_tenant and e.zoho_doc_id is null
                   and e.vendor_id = v_vendor.id and upper(btrim(e.bill_no)) = upper(v_num))
         or exists (select 1 from public.vendor_bills b where b.tenant_id = v_tenant and b.zoho_doc_id is null
                   and b.vendor_id = v_vendor.id and upper(btrim(b.bill_no)) = upper(v_num)) then
        v_reason := format('Bill %s of %s is already in the books (entered by hand) — not imported twice.', v_num, v_vendor.name);
      end if;
    end if;

    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    v_hash := upper(substr(md5(v_tenant::text || ':' || v_key), 1, 12));
    v_taxable := 0; v_tax := 0; v_amount := 0; v_ids := array[]::text[];
    begin
      if v_cogs > 0 then
        -- ONE COGS bill; its category = the largest leg's (one leg in practice).
        select l into v_leg from jsonb_array_elements(v_legs) l order by (l->>'taxable')::integer desc limit 1;
        v_taxable := (v_p->>'taxable')::integer;
        v_tax := (v_p->>'tax')::integer;
        v_amount := v_taxable + v_tax;
        insert into public.vendor_bills (
          id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category, line_items,
          subtotal, cgst, sgst, igst, total, status, paid_amount, currency, fx_rate, document_type, notes,
          zoho_doc_id, purchase_import_batch_id)
        values (
          'BILL-Z-' || v_hash, v_tenant, v_vendor.id, v_vendor.name, case when v_valid_g then v_gstin else v_vendor.gstin end,
          nullif(v_num, ''), v_date, v_due, v_leg->>'category',
          (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'description', left(coalesce(nullif(btrim(l->>'description'), ''), l->>'accountName', 'Item'), 300),
             'hsn', nullif(left(btrim(coalesce(l->>'hsn', '')), 12), ''),
             'qty', coalesce((l->>'qty')::numeric, 1), 'amount', coalesce((l->>'taxable')::integer, 0)))), '[]'::jsonb)
             from jsonb_array_elements(v_p->'lines') l),
          v_taxable, (v_p->>'cgst')::integer, (v_p->>'sgst')::integer, (v_p->>'igst')::integer, v_amount, 'unpaid', 0, 'INR', 1,
          case when v_valid_g or coalesce(v_vendor.gstin, '') ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then 'tax_invoice' else 'other' end,
          left(format('Imported from Zoho Books (bill %s).%s', coalesce(nullif(v_num, ''), v_zid),
            case when v_tds > 0 then format(' TDS %s ₹%s in Zoho — taken with its first payment.', v_tsec, v_tds) else '' end), 500),
          v_key, v_batch);
        v_ids := array['BILL-Z-' || v_hash];
      else
        v_i := 0;
        for v_leg in select l from jsonb_array_elements(v_legs) l loop
          v_i := v_i + 1;
          insert into public.expenses (
            id, tenant_id, category, vendor_name, vendor_id, expense_date, due_date, amount, gst_paid, igst, cgst, sgst,
            bill_type, bill_no, paid, paid_date, payment_method, description, notes, line_items,
            tds_section, tds_amount, rcm, rcm_tax, currency, fx_rate, zoho_doc_id, zoho_leg, purchase_import_batch_id)
          values (
            'EXP-Z-' || v_hash || '-' || v_i, v_tenant, v_leg->>'category', v_vendor.name, v_vendor.id, v_date,
            case when p_kind = 'bills' then coalesce(v_due, v_date) end,
            (v_leg->>'taxable')::integer + (v_leg->>'gst')::integer + (v_leg->>'cost_gst')::integer,
            (v_leg->>'gst')::integer,
            public._r2502_leg_head('igst', v_n_legs, v_rcm, v_leg, v_p),
            public._r2502_leg_head('cgst', v_n_legs, v_rcm, v_leg, v_p),
            public._r2502_leg_head('sgst', v_n_legs, v_rcm, v_leg, v_p),
            case when v_valid_g or coalesce(v_vendor.gstin, '') ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then 'gst' else 'none' end,
            nullif(v_num, ''),
            p_kind = 'expenses', case when p_kind = 'expenses' then v_date end, null,
            left(nullif(btrim(coalesce((select string_agg(nullif(btrim(coalesce(l->>'description', '')), ''), ', ') from jsonb_array_elements(v_leg->'lines') l), '')), ''), 500),
            left(format('Imported from Zoho Books (%s %s).%s%s', case when p_kind = 'bills' then 'bill' else 'expense' end, coalesce(nullif(v_num, ''), v_zid),
              case when (v_leg->>'cost_gst')::integer > 0 then format(' GST ₹%s not claimable in Zoho (ineligible ITC) — kept in the cost.', v_leg->>'cost_gst') else '' end,
              case when p_kind = 'expenses' and coalesce(v_p->>'paidThrough', '') <> '' then format(' Paid through %s in Zoho.', v_p->>'paidThrough') else '' end), 500),
            (select coalesce(jsonb_agg(jsonb_build_object(
               'name', left(coalesce(nullif(btrim(l->>'description'), ''), l->>'accountName', 'Item'), 300),
               'qty', coalesce((l->>'qty')::numeric, 1), 'amount', coalesce((l->>'taxable')::integer, 0))), '[]'::jsonb)
               from jsonb_array_elements(v_leg->'lines') l),
            case when v_i = 1 and v_tds > 0 then v_tsec end, case when v_i = 1 then v_tds else 0 end,
            v_rcm, case when v_rcm then (v_leg->>'rcm_tax')::integer else 0 end,
            'INR', 1, v_key, v_i, v_batch);
          v_ids := v_ids || ('EXP-Z-' || v_hash || '-' || v_i);
          v_taxable := v_taxable + (v_leg->>'taxable')::integer;
          v_tax := v_tax + (v_leg->>'gst')::integer;
          v_amount := v_amount + (v_leg->>'taxable')::integer + (v_leg->>'gst')::integer + (v_leg->>'cost_gst')::integer;
        end loop;
      end if;
    exception
      when others then
        v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', sqlerrm);
        continue;
    end;

    v_n := v_n + 1;
    v_sum_tx := v_sum_tx + v_taxable;
    v_sum_tax := v_sum_tax + v_tax;
    v_sum_amt := v_sum_amt + v_amount;
    v_done := v_done || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'ids', to_jsonb(v_ids),
      'target', case when v_cogs > 0 then 'vendor_bill' else 'expense' end, 'date', v_date, 'taxable', v_taxable, 'itc', v_tax, 'tds', v_tds);
  end loop;

  update public.zoho_fy_import_batches
     set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
         taxable_total = v_sum_tx, tax_total = v_sum_tax, amount_total = v_sum_amt, skipped = v_skipped
   where id = v_batch;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_purchases.imported', 'zoho_fy_import_batch', v_batch::text,
          left(format('Imported %s FY %s Zoho %s (taxable ₹%s, ITC ₹%s); %s skipped', v_n, p_fy, p_kind, v_sum_tx, v_sum_tax, jsonb_array_length(v_skipped)), 120),
          jsonb_build_object('batch_id', v_batch, 'kind', p_kind, 'fy', p_fy, 'imported', v_n, 'already', v_already,
                             'skipped', jsonb_array_length(v_skipped), 'taxable', v_sum_tx, 'itc', v_sum_tax, 'amount', v_sum_amt, 'new_vendors', v_new_v));

  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2502', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2502' then
    v_batch := null;
  end;
  perform set_config('app.zoho_purchase_import', '', true);

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'kind', p_kind, 'fy', p_fy,
    'imported', v_n, 'already', v_already, 'skipped', v_skipped, 'done', v_done, 'new_vendors', v_new_v,
    'taxable', v_sum_tx, 'itc', v_sum_tax, 'amount', v_sum_amt);
end;
$function$;
comment on function public.import_zoho_fy_purchases(text, text, jsonb, boolean) is
  'R-2502: FY bills / expenses from Zoho into vendor_bills (all-COGS bills) or expenses (one row per category). Money from zoho_fy_scan (server-read), picks = Zoho id + matched vendor. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_purchases(text, text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_purchases(text, text, jsonb, boolean) to authenticated, service_role;

-- ── 6. Vendor payments onto the imported bills ───────────────────────────────────────────────
create or replace function public.import_zoho_fy_vendor_payments(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 */
  v_tenant   uuid := public.current_tenant_id();
  v_start    date;
  v_lock     date;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_a        jsonb;
  v_zid      text;
  v_num      text;
  v_date     date;
  v_reason   text;
  v_bank     uuid;
  v_bill     public.vendor_bills;
  v_bill_p   jsonb;
  v_tds      integer;
  v_tsec     text;
  v_before   uuid[];
  v_txn      uuid;
  v_amt      integer;
  v_owed     integer;
  v_paid_z   integer;
  v_exp_ids  text[];
  v_prev     jsonb;
  v_links    integer;
  v_seen     text[] := array[]::text[];
  v_skipped  jsonb := '[]'::jsonb;
  v_part     jsonb := '[]'::jsonb;
  v_adv      jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_n        integer := 0;
  v_sum_amt  bigint := 0;
  v_sum_tds  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing payments needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY vendor payments from Zoho.' using errcode = '42501';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$' or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There is nothing to import. Preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many payments in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;
  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, 'vendorpayments', p_fy, auth.uid())
  returning id into v_batch;

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_id', ''));
    v_reason := null; v_num := v_zid; v_scan := null;
    if v_zid = '' or v_zid = any (v_seen) then
      v_reason := 'Listed twice or with no Zoho id.';
    else
      v_seen := v_seen || v_zid;
      select * into v_scan from public.zoho_fy_scan s
       where s.tenant_id = v_tenant and s.kind = 'vendorpayments' and s.zoho_id = v_zid and s.fy = p_fy;
      if not found or v_scan.payload is null then v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.'; end if;
    end if;
    if v_reason is null then
      v_p := v_scan.payload;
      v_num := coalesce(nullif(btrim(v_p->>'number'), ''), v_zid);
      begin v_date := (v_p->>'date')::date; exception when others then v_reason := 'Its date could not be read.'; end;
    end if;
    if v_reason is null then
      if lower(coalesce(v_p->>'status', '')) = 'void' then v_reason := 'Void in Zoho.';
      elsif jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then v_reason := v_p->'problems'->>0;
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif jsonb_typeof(v_p->'applied') <> 'array' or jsonb_array_length(v_p->'applied') = 0 then
        v_reason := 'An advance — not applied to any bill in Zoho; book it as an advance (Prepaid) by hand.';
      end if;
    end if;
    if v_reason is null and exists (select 1 from public.zoho_vendor_payment_links k where k.tenant_id = v_tenant and k.zoho_payment_id = v_zid) then
      v_already := v_already + 1;
      continue;
    end if;
    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    v_bank := nullif(v_pick->>'bank_account_id', '')::uuid;
    v_links := 0;
    begin
      for v_a in select value from jsonb_array_elements(v_p->'applied') loop
        v_amt := (v_a->>'amount')::integer;
        select * into v_bill from public.vendor_bills b where b.tenant_id = v_tenant and b.zoho_doc_id = 'bills:' || (v_a->>'billZohoId') for update;
        if found then
          if v_bank is null or not exists (select 1 from public.bank_accounts ba where ba.id = v_bank and ba.tenant_id = v_tenant) then
            raise exception 'Pick the bank account this payment was made from (it pays COGS bill %).', coalesce(v_bill.bill_no, v_bill.id) using errcode = 'R2503';
          end if;
          select s.payload into v_bill_p from public.zoho_fy_scan s where s.tenant_id = v_tenant and s.kind = 'bills' and s.zoho_id = v_a->>'billZohoId';
          v_tds := 0; v_tsec := null;
          if coalesce((v_bill_p->>'tdsAmount')::integer, 0) > 0 and coalesce(v_bill.paid_amount, 0) = 0
             and not exists (select 1 from public.bank_vendor_payment_lines l where l.vendor_bill_id = v_bill.id and l.tds_amount > 0) then
            v_tds := (v_bill_p->>'tdsAmount')::integer;
            v_tsec := v_bill_p->>'tdsSection';
          end if;
          select coalesce(array_agg(t.id), '{}') into v_before from public.bank_transactions t
           where t.tenant_id = v_tenant and t.matched_to_type = 'vendor_bill' and t.matched_to_id = v_bill.id;
          perform public.pay_vendor_bill(v_bill.id, v_amt, v_date, v_bank, nullif(left(coalesce(v_p->>'mode', ''), 60), ''), v_tds, v_tsec, null);
          select t.id into v_txn from public.bank_transactions t
           where t.tenant_id = v_tenant and t.matched_to_type = 'vendor_bill' and t.matched_to_id = v_bill.id and t.source = 'manual'
             and not (t.id = any (v_before)) limit 1;
          insert into public.zoho_vendor_payment_links (tenant_id, batch_id, zoho_payment_id, zoho_bill_id, target_type, target_ids, amount, tds_amount, bank_txn_id, settled, prev)
          values (v_tenant, v_batch, v_zid, v_a->>'billZohoId', 'vendor_bill', array[v_bill.id], v_amt, v_tds, v_txn, true,
                  jsonb_build_object('paid_amount', v_bill.paid_amount, 'status', v_bill.status));
          v_sum_tds := v_sum_tds + v_tds;
        else
          select array_agg(e.id order by e.zoho_leg), coalesce(sum(e.amount), 0), coalesce(sum(e.tds_amount), 0),
                 jsonb_object_agg(e.id, jsonb_build_object('paid', e.paid, 'paid_date', e.paid_date, 'payment_method', e.payment_method))
            into v_exp_ids, v_owed, v_tds, v_prev
            from public.expenses e where e.tenant_id = v_tenant and e.zoho_doc_id = 'bills:' || (v_a->>'billZohoId');
          if v_exp_ids is null then
            raise exception 'Bill % is not in the app yet — Import the bills first.', coalesce(nullif(v_a->>'billNumber', ''), v_a->>'billZohoId') using errcode = 'R2503';
          end if;
          if exists (select 1 from public.expenses e where e.id = any (v_exp_ids) and (e.paid or e.paid_amount > 0)) then
            raise exception 'Bill % is already paid in the app.', coalesce(nullif(v_a->>'billNumber', ''), v_a->>'billZohoId') using errcode = 'R2503';
          end if;
          select coalesce(sum(k.amount), 0) + v_amt into v_paid_z from public.zoho_vendor_payment_links k
           where k.tenant_id = v_tenant and k.zoho_bill_id = v_a->>'billZohoId';
          insert into public.zoho_vendor_payment_links (tenant_id, batch_id, zoho_payment_id, zoho_bill_id, target_type, target_ids, amount, settled, prev)
          values (v_tenant, v_batch, v_zid, v_a->>'billZohoId', 'expense', v_exp_ids, v_amt, v_paid_z + v_tds >= v_owed, v_prev);
          if v_paid_z + v_tds >= v_owed then
            update public.expenses set paid = true, paid_date = v_date, payment_method = nullif(left(coalesce(v_p->>'mode', ''), 60), '')
             where id = any (v_exp_ids);
          else
            v_part := v_part || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'bill', v_a->>'billNumber', 'paid', v_paid_z, 'owed', v_owed - v_tds);
          end if;
        end if;
        v_links := v_links + 1;
        v_sum_amt := v_sum_amt + v_amt;
      end loop;
    exception
      when others then
        v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', sqlerrm);
        continue;
    end;
    if coalesce((v_p->>'unapplied')::integer, 0) > 0 then
      v_adv := v_adv || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'vendor', v_p->>'vendorName', 'amount', (v_p->>'unapplied')::integer);
    end if;
    v_n := v_n + 1;
  end loop;

  update public.zoho_fy_import_batches
     set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
         tax_total = v_sum_tds, amount_total = v_sum_amt, skipped = v_skipped
   where id = v_batch;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_vendor_payments.imported', 'zoho_fy_import_batch', v_batch::text,
          left(format('Imported %s FY %s Zoho vendor payments (₹%s, TDS ₹%s); %s skipped', v_n, p_fy, v_sum_amt, v_sum_tds, jsonb_array_length(v_skipped)), 120),
          jsonb_build_object('batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already, 'skipped', jsonb_array_length(v_skipped),
                             'amount', v_sum_amt, 'tds', v_sum_tds, 'part_paid', v_part, 'advances', v_adv));
  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2502', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2502' then
    v_batch := null;
  end;

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already,
    'skipped', v_skipped, 'part_paid', v_part, 'advances', v_adv, 'amount', v_sum_amt, 'tds', v_sum_tds);
end;
$function$;
comment on function public.import_zoho_fy_vendor_payments(text, jsonb, boolean) is
  'R-2502: FY Zoho vendor payments onto imported bills — COGS bills via pay_vendor_bill (manual bank line, matched later), expense bills marked paid once covered. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_vendor_payments(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_vendor_payments(text, jsonb, boolean) to authenticated, service_role;

-- ── 7. Take one batch back (while untouched) ─────────────────────────────────────────────────
create or replace function public.remove_zoho_fy_purchase_import(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 */
  v_tenant uuid := public.current_tenant_id();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_batch  public.zoho_fy_import_batches;
  v_bad    text;
  v_k      public.zoho_vendor_payment_links;
  v_n      integer := 0;
  v_m      integer;
begin
  if v_tenant is null then
    raise exception 'Removing an import needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can remove an import.' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'Write why you are removing this import (at least 3 characters) — it goes in the activity log.' using errcode = '22023';
  end if;
  select * into v_batch from public.zoho_fy_import_batches where id = p_batch_id and tenant_id = v_tenant for update;
  if not found or v_batch.kind not in ('bills', 'expenses', 'vendorpayments') then
    raise exception 'That import was not found. Refresh and look at the imports list again.' using errcode = 'P0002';
  end if;
  if v_batch.removed_at is not null then
    raise exception 'This import was already removed on %.', to_char(v_batch.removed_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
  end if;

  if v_batch.kind in ('bills', 'expenses') then
    select string_agg(x.ref, ', ') into v_bad from (
      select coalesce(e.bill_no, e.id) as ref from public.expenses e
       where e.purchase_import_batch_id = p_batch_id and e.tenant_id = v_tenant
         and (e.reconciled_txn_id is not null or e.advance_applied > 0 or e.paid_amount > 0
           or (e.paid and v_batch.kind = 'bills')
           or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id)
           or exists (select 1 from public.zoho_vendor_payment_links k where k.tenant_id = v_tenant and e.id = any (k.target_ids)))
      union all
      select coalesce(b.bill_no, b.id) from public.vendor_bills b
       where b.purchase_import_batch_id = p_batch_id and b.tenant_id = v_tenant
         and (b.paid_amount <> 0 or b.advance_applied > 0
           or exists (select 1 from public.bank_vendor_payment_lines l where l.vendor_bill_id = b.id)
           or exists (select 1 from public.bank_transactions t where t.matched_to_type = 'vendor_bill' and t.matched_to_id = b.id))
      limit 20) x;
    if v_bad is not null then
      raise exception 'This import cannot be removed: % already has a payment or bank match. Take that off first (or remove the payments import), then remove this one.', v_bad using errcode = 'P0001';
    end if;
    delete from public.expenses where purchase_import_batch_id = p_batch_id and tenant_id = v_tenant;
    get diagnostics v_m = row_count; v_n := v_m;
    delete from public.vendor_bills where purchase_import_batch_id = p_batch_id and tenant_id = v_tenant;
    get diagnostics v_m = row_count; v_n := v_n + v_m;
  else
    /* A later payments import on the same bill builds on this one — take that back first. */
    select string_agg(distinct k2.zoho_bill_id, ', ') into v_bad
      from public.zoho_vendor_payment_links k
      join public.zoho_vendor_payment_links k2
        on k2.tenant_id = k.tenant_id and k2.zoho_bill_id = k.zoho_bill_id and k2.batch_id <> k.batch_id and k2.created_at > k.created_at
     where k.batch_id = p_batch_id and k.tenant_id = v_tenant;
    if v_bad is not null then
      raise exception 'A later payments import also paid the same bills (Zoho bill %) — remove that import first.', v_bad using errcode = 'P0001';
    end if;
    for v_k in select * from public.zoho_vendor_payment_links where batch_id = p_batch_id and tenant_id = v_tenant order by created_at desc, id loop
      if v_k.target_type = 'vendor_bill' then
        if v_k.bank_txn_id is null or not exists (select 1 from public.bank_transactions t where t.id = v_k.bank_txn_id and t.source = 'manual'
                                                    and t.matched_to_type = 'vendor_bill' and t.matched_to_id = v_k.target_ids[1]) then
          raise exception 'The payment on COGS bill % was matched to a bank line already — un-reconcile it in Banking first.', v_k.target_ids[1] using errcode = 'P0001';
        end if;
        delete from public.bank_vendor_payment_lines where bank_txn_id = v_k.bank_txn_id;
        delete from public.bank_transactions where id = v_k.bank_txn_id;
        /* Take back exactly this payment (cash + its TDS) — order-free, so several payments on one
           bill in one batch, or other batches' payments on it, stay right. */
        update public.vendor_bills
           set paid_amount = greatest(0, paid_amount - v_k.amount - v_k.tds_amount),
               status = case when paid_amount - v_k.amount - v_k.tds_amount <= 0 then 'unpaid'
                             when paid_amount - v_k.amount - v_k.tds_amount >= total then 'paid' else 'partial' end,
               updated_at = now()
         where id = v_k.target_ids[1] and tenant_id = v_tenant;
      else
        if exists (select 1 from public.expenses e where e.id = any (v_k.target_ids)
                     and (e.reconciled_txn_id is not null or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id))) then
          raise exception 'Expense bill % was matched to a bank line already — un-reconcile it in Banking first.', v_k.target_ids[1] using errcode = 'P0001';
        end if;
        if v_k.settled then
          update public.expenses e
             set paid = coalesce((v_k.prev->e.id->>'paid')::boolean, false),
                 paid_date = nullif(v_k.prev->e.id->>'paid_date', '')::date,
                 payment_method = nullif(v_k.prev->e.id->>'payment_method', '')
           where e.id = any (v_k.target_ids) and e.tenant_id = v_tenant;
        end if;
      end if;
      delete from public.zoho_vendor_payment_links where id = v_k.id;
      v_n := v_n + 1;
    end loop;
  end if;

  update public.zoho_fy_import_batches
     set removed_at = now(), removed_by = auth.uid(), remove_reason = left(v_reason, 500), removed_rows = v_n
   where id = p_batch_id;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_purchases.import_removed', 'zoho_fy_import_batch', p_batch_id::text,
          left(format('Removed FY %s Zoho %s import: %s rows — %s', v_batch.fy, v_batch.kind, v_n, v_reason), 120),
          jsonb_build_object('batch_id', p_batch_id, 'kind', v_batch.kind, 'removed', v_n, 'reason', v_reason, 'fy', v_batch.fy));
  return jsonb_build_object('removed', v_n, 'batch_id', p_batch_id, 'kind', v_batch.kind);
end;
$function$;
comment on function public.remove_zoho_fy_purchase_import(uuid, text) is
  'R-2502: takes one FY purchase / vendor-payment import batch back while untouched (no payment or bank match on its rows). Vendors it created stay. Owner / accountant; activity_log; the batch row stays, marked removed.';
revoke all on function public.remove_zoho_fy_purchase_import(uuid, text) from public, anon;
grant execute on function public.remove_zoho_fy_purchase_import(uuid, text) to authenticated, service_role;


-- ── 8. Only the import writes the Zoho id / batch; nobody changes them afterwards ───────────
-- (R-2499 pattern.) An owner / accountant may UPDATE expenses and vendor_bills; without this a hand
-- entry could be tagged into a batch and then deleted by the batch undo.
create or replace function public.tg_purchases_zoho_doc_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  /* R-2502 */
  if tg_op = 'INSERT' then
    if (new.zoho_doc_id is not null or new.purchase_import_batch_id is not null)
       and coalesce(current_setting('app.zoho_purchase_import', true), '') <> 'on' then
      raise exception 'A purchase from Zoho can only be added by Expenses → FY 2025-26 purchases from Zoho.'
        using errcode = 'check_violation';
    end if;
  elsif new.zoho_doc_id is distinct from old.zoho_doc_id
     or new.purchase_import_batch_id is distinct from old.purchase_import_batch_id then
    raise exception '%: which Zoho document it came from cannot be changed.', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke all on function public.tg_purchases_zoho_doc_guard() from public, anon, authenticated;

drop trigger if exists trg_vendor_bills_zoho_doc_guard on public.vendor_bills;
create trigger trg_vendor_bills_zoho_doc_guard
  before insert or update of zoho_doc_id, purchase_import_batch_id on public.vendor_bills
  for each row execute function public.tg_purchases_zoho_doc_guard();
drop trigger if exists trg_expenses_zoho_doc_guard on public.expenses;
create trigger trg_expenses_zoho_doc_guard
  before insert or update of zoho_doc_id, zoho_leg, purchase_import_batch_id on public.expenses
  for each row execute function public.tg_purchases_zoho_doc_guard();

commit;
