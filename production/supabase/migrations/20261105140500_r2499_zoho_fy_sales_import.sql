-- deploy-peek: to_regclass('public.zoho_sale_import_batches') is not null and to_regclass('public.zoho_sale_import_scan') is not null and to_regclass('public.zoho_sale_import_runs') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invoices' and column_name = 'zoho_invoice_id') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_sales(text,jsonb,boolean)') and prosrc like '%R-2499%') and to_regprocedure('public.remove_zoho_fy_sales_import(uuid,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_invoices_block_delete_issued()') and prosrc like '%R-2499%')
-- deploy-key: r2499zohofysales
--
-- R-2499 (goal G-FY2526, owner decision D2, 5 Nov 2026): Excel's FY 2025-26 sales come in as ZOHO'S
-- OWN INVOICES — Zoho's number and date, the taxable value, the GST it charged (IGST, or CGST + SGST)
-- and its lines — as ordinary sale invoices (document_kind tax_invoice through the usual triggers),
-- so revenue, GSTR-1 / 3B, the day book and the ledger count them with the formulas they already use
-- (invoice_is_sale, taxable_value, tax_amount, inter_state — no new formula).
--
-- ══ WHAT THIS ADDS ═════════════════════════════════════════════════════════════════════════════
--   1. invoices.zoho_invoice_id (Zoho's own id; unique per company → a rerun never makes a second
--      sale) + invoices.sale_import_batch_id (the batch that brought it in).
--   2. zoho_sale_import_runs / zoho_sale_import_scan — the server's own copy of what it read from
--      Zoho (list walk + each invoice's detail, already in WHOLE RUPEES — the paise → rupees step is
--      lib/integrations/zoho-books/sales-import/normalise.ts). Written only by the server
--      (service_role); the import reads the money from here, never from the browser.
--   3. zoho_sale_import_batches — one row per Import part (who, when, FY, counts, totals, skipped
--      with reasons) + one activity_log row per batch (zoho_fy_sales.imported).
--   4. import_zoho_fy_sales(fy, picks, dry_run) — OWNER / ACCOUNTANT. `picks` names Zoho ids with
--      the customer (and catalogue items) the preview matched; every money fact comes from the scan.
--      Per invoice, refused (skipped, with the reason) when: void / draft in Zoho; a problem the
--      scan found (mixed rates, adjustment, …); outside the FY; no books start, or dated before it
--      (R-2496 books_start_for); inside the books lock (books_locked_until — the lock trigger stays
--      the last word); already imported (same Zoho id → 'already'); the Zoho number is already an
--      OPENING invoice (R-2504's data repair converts those — never a second copy) or any other
--      invoice's number; the customer is not this company's; any trigger refusal (supplier not
--      registered on that date, export with no LUT for FY 2025-26, …) — caught per invoice.
--      dry_run = the same inserts inside a sub-transaction that is rolled back: the preview shows
--      exactly what Import would do and writes nothing (no batch, no log).
--      Every imported invoice: paid_amount 0 (receipts come only from R-2501), no quote, no app
--      number series (id = Zoho number; '<number>-<doc_code>' only when another company holds it),
--      no IRN.
--   5. remove_zoho_fy_sales_import(batch, reason) — OWNER / ACCOUNTANT: takes one batch back while
--      nothing touched it (no payment, TDS, late fee, credit / debit note, write-off, paid 0).
--      tg_invoices_block_delete_issued lets exactly that batch's rows go (app.zoho_sale_remove).
--   6. No mirror to a child company's bills and no network copy for an imported sale (those
--      triggers get WHEN (new.zoho_invoice_id is null)) — the buyer booked its FY 2025-26 bill itself.
--   The dunning cron leaves these invoices alone (route.ts filters zoho_invoice_id is null): no
--   reminder emails for FY 2025-26 Zoho sales while their receipts are still to come (R-2501).
--
-- Cloud SQL: no extensions schema; auth.uid()/auth.role() rewritten by the deploy script.
-- Grants explicit (no PUBLIC EXECUTE). service_role policy (R-450).
-- Test: supabase/tests/r2499_zoho_fy_sales_import.test.sql (rolled back).
-- Rollback: drop the two functions, restore tg_invoices_block_delete_issued from
--   20261022013149_r1739_zoho_opening_invoices.sql, recreate the two triggers without WHEN, drop the
--   three tables and the two columns (only after removing every imported batch).

begin;

-- ── 1. Batches ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.zoho_sale_import_batches (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references public.tenants(id) on delete cascade,
  fy             text        not null check (fy ~ '^\d{4}-\d{2}$'),
  imported_count integer     not null default 0 check (imported_count >= 0),
  skipped_count  integer     not null default 0 check (skipped_count >= 0),
  already_count  integer     not null default 0 check (already_count >= 0),
  taxable_total  bigint      not null default 0,
  tax_total      bigint      not null default 0,
  amount_total   bigint      not null default 0,
  skipped        jsonb       not null default '[]'::jsonb,
  created_by     uuid        references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  removed_at     timestamptz,
  removed_by     uuid        references public.users(id) on delete set null,
  remove_reason  text        check (remove_reason is null or char_length(remove_reason) <= 500),
  removed_rows   integer     check (removed_rows is null or removed_rows >= 0)
);
comment on table public.zoho_sale_import_batches is
  'R-2499: one row per "Import FY sales from Zoho" part. Written only by import_zoho_fy_sales() / remove_zoho_fy_sales_import(); a removed batch keeps its row with removed_at.';
create index if not exists zoho_sale_import_batches_tenant_idx on public.zoho_sale_import_batches (tenant_id, created_at desc);

alter table public.zoho_sale_import_batches enable row level security;
revoke all on table public.zoho_sale_import_batches from public, anon, authenticated;
grant select on table public.zoho_sale_import_batches to authenticated;
grant all on table public.zoho_sale_import_batches to service_role;
drop policy if exists zoho_sale_import_batches_select on public.zoho_sale_import_batches;
create policy zoho_sale_import_batches_select on public.zoho_sale_import_batches as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));
drop policy if exists zzz_service_role_all on public.zoho_sale_import_batches;
create policy zzz_service_role_all on public.zoho_sale_import_batches as permissive for all to service_role using (true) with check (true);

-- ── 2. The server's scan of Zoho (service_role only) ──────────────────────────────────────────
create table if not exists public.zoho_sale_import_runs (
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  fy          text        not null check (fy ~ '^\d{4}-\d{2}$'),
  next_page   integer     not null default 1 check (next_page >= 1),
  list_done   boolean     not null default false,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, fy)
);
comment on table public.zoho_sale_import_runs is
  'R-2499: where the server''s walk of Zoho''s FY invoice list stands (next page, list finished). Server only.';

create table if not exists public.zoho_sale_import_scan (
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  fy              text        not null check (fy ~ '^\d{4}-\d{2}$'),
  zoho_invoice_id text        not null check (char_length(zoho_invoice_id) between 1 and 40),
  number          text        not null check (char_length(number) <= 60),
  invoice_date    date,
  zoho_status     text        not null default '',
  payload         jsonb,
  listed_at       timestamptz not null default now(),
  detailed_at     timestamptz,
  primary key (tenant_id, zoho_invoice_id)
);
comment on table public.zoho_sale_import_scan is
  'R-2499: one row per Zoho invoice the server listed for the FY; payload = its facts in WHOLE RUPEES (normalise.ts), null until the detail is read. Server only; the import takes its money from here.';
create index if not exists zoho_sale_import_scan_fy_idx on public.zoho_sale_import_scan (tenant_id, fy, invoice_date);

do $$
declare t text;
begin
  foreach t in array array['zoho_sale_import_runs', 'zoho_sale_import_scan'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

-- ── 3. invoices: Zoho id + batch ─────────────────────────────────────────────────────────────
alter table public.invoices add column if not exists zoho_invoice_id text;
alter table public.invoices add column if not exists sale_import_batch_id uuid
  references public.zoho_sale_import_batches(id) on delete restrict;
create unique index if not exists invoices_tenant_zoho_invoice_id_uq
  on public.invoices (tenant_id, zoho_invoice_id) where zoho_invoice_id is not null;
create index if not exists invoices_sale_import_batch_idx
  on public.invoices (sale_import_batch_id) where sale_import_batch_id is not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_zoho_sale_shape') then
    alter table public.invoices add constraint invoices_zoho_sale_shape check (
      (zoho_invoice_id is null) = (sale_import_batch_id is null)
      and (zoho_invoice_id is null or (external_number is not null and quote_id is null)));
  end if;
end $$;
comment on column public.invoices.zoho_invoice_id is
  'R-2499: Zoho Books invoice_id of an FY sale imported as Zoho''s own invoice (unique per company — a rerun skips it). NULL on every other invoice.';
comment on column public.invoices.sale_import_batch_id is
  'R-2499: the zoho_sale_import_batches row that brought this sale in.';

-- ── 4. Import (and dry run) ──────────────────────────────────────────────────────────────────
create or replace function public.import_zoho_fy_sales(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2499 */
  v_tenant   uuid := public.current_tenant_id();
  v_start    date;
  v_lock     date;
  v_code     text;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_sale_import_scan;
  v_p        jsonb;
  v_zid      text;
  v_num      text;
  v_date     date;
  v_due      date;
  v_status   text;
  v_cust     record;
  v_id       text;
  v_lines    jsonb;
  v_taxable  integer;
  v_tax      integer;
  v_amount   integer;
  v_rate     numeric;
  v_reason   text;
  v_clash    record;
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
    raise exception 'Importing sales needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY sales from Zoho. Ask one of them.'
      using errcode = '42501';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$'
     or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There are no invoices to import. Read from Zoho again and preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many invoices in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;

  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until,
         coalesce(nullif(btrim(t.doc_code), ''), upper(left(replace(t.id::text, '-', ''), 4)))
    into v_lock, v_code
    from public.tenants t where t.id = v_tenant;

  /* The whole run sits in one block: a dry run raises R2499 at the end, so the batch row, every
     invoice and every trigger's work (activity log, …) roll back — the preview ran the real thing. */
  begin
  insert into public.zoho_sale_import_batches (tenant_id, fy, created_by)
  values (v_tenant, p_fy, auth.uid())
  returning id into v_batch;

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_invoice_id', ''));
    v_reason := null;
    v_scan := null;
    v_num := v_zid;

    if v_zid = '' or v_zid = any (v_seen) then
      v_reason := 'Listed twice or with no Zoho id.';
    else
      v_seen := v_seen || v_zid;
      select * into v_scan from public.zoho_sale_import_scan s
       where s.tenant_id = v_tenant and s.zoho_invoice_id = v_zid and s.fy = p_fy;
      if not found or v_scan.payload is null then
        v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.';
      end if;
    end if;

    if v_reason is null then
      v_p      := v_scan.payload;
      v_num    := btrim(coalesce(v_p->>'number', ''));
      v_status := lower(coalesce(v_p->>'status', ''));
      begin
        v_date    := (v_p->>'date')::date;
        v_due     := nullif(v_p->>'dueDate', '')::date;
        v_taxable := (v_p->>'taxable')::integer;
        v_tax     := (v_p->>'tax')::integer;
        v_amount  := (v_p->>'amount')::integer;
        v_rate    := nullif(v_p->>'taxRate', '')::numeric;
      exception when others then
        v_reason := 'Its date or amounts could not be read — read it from Zoho again.';
      end;
    end if;

    if v_reason is null then
      if v_status = 'void' then v_reason := 'Void in Zoho — not a sale, not in revenue or GST.';
      elsif v_status = 'draft' then v_reason := 'Draft in Zoho — never issued, not in revenue or GST.';
      elsif jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then
        v_reason := v_p->'problems'->>0;
      elsif v_num = '' or char_length(v_num) > 40 then v_reason := 'The Zoho number is empty or longer than 40 characters.';
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then
        v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then
        v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then
        v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then
        v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif v_taxable is null or v_tax is null or v_amount is null
         or v_taxable < 0 or v_tax < 0 or v_amount <= 0 or abs(v_amount - v_taxable - v_tax) > 1 then
        v_reason := 'Taxable, GST and total do not add up.';
      elsif v_rate is null or v_rate < 0 or v_rate > 28 or (v_tax > 0 and v_rate = 0) then
        v_reason := 'The GST rate cannot be read.';
      end if;
    end if;

    -- Already here? Same Zoho id → already (a rerun); same number on another invoice → skipped.
    if v_reason is null then
      if exists (select 1 from public.invoices i where i.tenant_id = v_tenant and i.zoho_invoice_id = v_zid) then
        v_already := v_already + 1;
        continue;
      end if;
      select i.id, i.document_kind into v_clash from public.invoices i
       where i.tenant_id = v_tenant
         and (upper(i.external_number) = upper(v_num) or upper(i.id) = upper(v_num))
       order by (i.document_kind = 'opening_invoice') desc
       limit 1;
      if found then
        if v_clash.document_kind = 'opening_invoice' then
          v_reason := format('%s is already an opening invoice — the data repair (R-2504) converts it; it is not imported twice.', v_num);
        else
          v_reason := format('%s is already on invoice %s.', v_num, v_clash.id);
        end if;
      end if;
    end if;

    if v_reason is null then
      select c.id, c.name into v_cust from public.customers c
       where c.id = nullif(v_pick->>'customer_id', '')::uuid and c.tenant_id = v_tenant;
      if not found then
        v_reason := format('No customer for "%s" in your company — import customers from Zoho first.', coalesce(v_p->>'customerName', ''));
      end if;
    end if;

    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_invoice_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    -- Lines as stored on our invoices (name, hsn, qty, rate, amount, item_id when it is this company's).
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'name',         left(coalesce(nullif(btrim(l->>'name'), ''), 'Item'), 300),
             'description',  nullif(left(btrim(coalesce(l->>'description', '')), 1000), ''),
             'hsn',          nullif(left(btrim(coalesce(l->>'hsn', '')), 12), ''),
             'qty',          coalesce((l->>'qty')::numeric, 1),
             'rate',         coalesce((l->>'rate')::numeric, 0),
             'amount',       coalesce((l->>'taxable')::integer, 0),
             'item_id',      it.id,
             'zoho_item_id', nullif(l->>'zohoItemId', '')
           )) order by x.ord), '[]'::jsonb)
      into v_lines
      from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) with ordinality x(l, ord)
      left join public.items it
        on it.tenant_id = v_tenant
       and it.id = (case when jsonb_typeof(v_pick->'item_ids') = 'array' then v_pick->'item_ids'->>(x.ord::int - 1) end);

    v_id := v_num;
    if exists (select 1 from public.invoices i where i.id = v_id) then
      v_id := left(v_num, 40) || '-' || v_code;
    end if;

    begin
      insert into public.invoices (
        id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status,
        invoice_date, due_date, taxable_value, tax_amount, tax_rate, inter_state, line_items,
        customer_gstin, pos_state_code, gst_treatment, currency, fx_rate,
        external_number, zoho_invoice_id, sale_import_batch_id)
      values (
        v_id, v_tenant, v_cust.id, v_cust.name, v_amount, v_amount, 0,
        case when coalesce(v_due, v_date) < public.ist_today() then 'overdue' else 'pending' end::public.invoice_status,
        v_date, coalesce(v_due, v_date), v_taxable, v_tax, v_rate, (v_p->>'head') = 'igst', v_lines,
        nullif(upper(btrim(coalesce(v_p->>'gstin', ''))), ''),
        nullif(btrim(coalesce(v_p->>'posStateCode', '')), ''),
        nullif(v_p->>'appGstTreatment', ''),
        nullif(upper(btrim(coalesce(v_p->>'currency', ''))), 'INR'),
        case when upper(coalesce(v_p->>'currency', 'INR')) <> 'INR' then nullif(v_p->>'fxRate', '')::numeric end,
        v_num, v_zid, v_batch);
    exception
      when others then
        v_skipped := v_skipped || jsonb_build_object('zoho_invoice_id', v_zid, 'number', v_num, 'reason', sqlerrm);
        continue;
    end;

    v_n := v_n + 1;
    v_sum_tx := v_sum_tx + v_taxable;
    v_sum_tax := v_sum_tax + v_tax;
    v_sum_amt := v_sum_amt + v_amount;
    v_done := v_done || jsonb_build_object('zoho_invoice_id', v_zid, 'number', v_num, 'invoice_id', v_id,
      'date', v_date, 'taxable', v_taxable, 'tax', v_tax, 'inter_state', (v_p->>'head') = 'igst');
  end loop;

  update public.zoho_sale_import_batches
       set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
           taxable_total = v_sum_tx, tax_total = v_sum_tax, amount_total = v_sum_amt, skipped = v_skipped
     where id = v_batch;
    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (v_tenant, auth.uid(), 'zoho_fy_sales.imported', 'zoho_sale_import_batch', v_batch::text,
            left(format('Imported %s FY %s sales from Zoho (taxable ₹%s, GST ₹%s); %s skipped', v_n, p_fy, v_sum_tx, v_sum_tax, jsonb_array_length(v_skipped)), 120),
            jsonb_build_object('batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already,
                               'skipped', jsonb_array_length(v_skipped), 'taxable', v_sum_tx, 'tax', v_sum_tax, 'amount', v_sum_amt));

  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2499', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2499' then
    v_batch := null;   -- dry run: nothing written
  end;

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'fy', p_fy,
    'imported', v_n, 'already', v_already, 'skipped', v_skipped, 'done', v_done,
    'taxable', v_sum_tx, 'tax', v_sum_tax, 'amount', v_sum_amt);
end;
$function$;

comment on function public.import_zoho_fy_sales(text, jsonb, boolean) is
  'R-2499: FY sales from Zoho as Zoho''s own invoices (number, date, GST). Money from zoho_sale_import_scan (server-read), picks = Zoho id + matched customer / items. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_sales(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_sales(text, jsonb, boolean) to authenticated, service_role;

-- ── 5. Take one batch back (nothing may have touched it) ─────────────────────────────────────
create or replace function public.remove_zoho_fy_sales_import(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2499 */
  v_tenant uuid := public.current_tenant_id();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_batch  public.zoho_sale_import_batches;
  v_ids    text[];
  v_bad    text;
  v_n      integer;
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
  select * into v_batch from public.zoho_sale_import_batches
   where id = p_batch_id and tenant_id = v_tenant for update;
  if not found then
    raise exception 'That import was not found. Refresh and look at the imports list again.' using errcode = 'P0002';
  end if;
  if v_batch.removed_at is not null then
    raise exception 'This import was already removed on %.', to_char(v_batch.removed_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
  end if;

  select array_agg(i.id order by i.id) into v_ids
    from (select id from public.invoices where sale_import_batch_id = p_batch_id and tenant_id = v_tenant for update) i;

  select string_agg(x.id, ', ' order by x.id) into v_bad
    from (select i.id from public.invoices i
           where i.id = any (coalesce(v_ids, '{}'::text[]))
             and (i.paid_amount <> 0 or i.written_off_at is not null or i.status = 'void'
               or exists (select 1 from public.payments p where p.invoice_id = i.id)
               or exists (select 1 from public.tds_receivable t where t.invoice_id = i.id and t.status <> 'reversed')
               or exists (select 1 from public.late_charge_bills l where l.invoice_id = i.id)
               or exists (select 1 from public.credit_notes c where c.invoice_id = i.id)
               or exists (select 1 from public.debit_notes d where d.invoice_id = i.id))
           limit 20) x;
  if v_bad is not null then
    raise exception 'This import cannot be removed: a payment, TDS, late fee or note is already on %. Take that off first, then remove the import.', v_bad using errcode = 'P0001';
  end if;

  perform set_config('app.zoho_sale_remove', p_batch_id::text, true);
  delete from public.invoices where id = any (coalesce(v_ids, '{}'::text[])) and tenant_id = v_tenant;
  get diagnostics v_n = row_count;
  perform set_config('app.zoho_sale_remove', '', true);

  update public.zoho_sale_import_batches
     set removed_at = now(), removed_by = auth.uid(), remove_reason = left(v_reason, 500), removed_rows = v_n
   where id = p_batch_id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_sales.import_removed', 'zoho_sale_import_batch', p_batch_id::text,
          left(format('Removed FY %s sales import: %s invoices — %s', v_batch.fy, v_n, v_reason), 120),
          jsonb_build_object('batch_id', p_batch_id, 'removed', v_n, 'reason', v_reason, 'fy', v_batch.fy));

  return jsonb_build_object('removed', v_n, 'batch_id', p_batch_id);
end;
$function$;

comment on function public.remove_zoho_fy_sales_import(uuid, text) is
  'R-2499: takes one FY sales import batch back while untouched (no payment, TDS, late fee, note, write-off; paid 0). Owner / accountant; activity_log; the batch row stays, marked removed.';
revoke all on function public.remove_zoho_fy_sales_import(uuid, text) from public, anon;
grant execute on function public.remove_zoho_fy_sales_import(uuid, text) to authenticated, service_role;

-- ── 6. Delete guard: let exactly the batch being removed go ──────────────────────────────────
-- ← 20261022013149_r1739_zoho_opening_invoices.sql (latest), + the R-2499 branch.
create or replace function public.tg_invoices_block_delete_issued()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reason text := nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '');
begin
  if old.status = 'draft' then
    return old;
  end if;

  /* R-1739: remove_opening_invoice_import() takes back a whole Zoho import (no payment on it).
     Those numbers are Zoho's, not our GST series — no gap is left. Only that batch. */
  if old.document_kind = 'opening_invoice'
     and old.import_batch_id is not null
     and coalesce(current_setting('app.opening_invoice_remove', true), '') = old.import_batch_id::text then
    return old;
  end if;

  /* R-2499: remove_zoho_fy_sales_import() takes back one FY sales batch from Zoho (untouched).
     Zoho's numbers, not our series — no gap. Only that batch. */
  if old.sale_import_batch_id is not null
     and coalesce(current_setting('app.zoho_sale_remove', true), '') = old.sale_import_batch_id::text then
    return old;
  end if;

  if v_reason is not null then
    raise notice '[invoices] % deleted under app.invoice_amend_reason=%', old.id, v_reason;
    return old;
  end if;

  raise exception
    'Invoice % is % and cannot be deleted. Its number is already spent from the GST series and deleting it leaves a permanent gap. To cancel it, raise a credit note against it (issue_credit_note) — that keeps both documents on the record, which is what CGST Section 34 requires.',
    old.id, old.status
    using errcode = 'restrict_violation';
end;
$function$;

-- ── 7. No child bill / network copy for an imported FY sale ──────────────────────────────────
drop trigger if exists trg_mirror_invoice_to_child on public.invoices;
create trigger trg_mirror_invoice_to_child
  after insert or update of status on public.invoices
  for each row when (new.zoho_invoice_id is null)
  execute function public.tg_mirror_invoice_to_child_vendor_bill();

drop trigger if exists trg_network_invoice_issue on public.invoices;
create trigger trg_network_invoice_issue
  after insert or update of status on public.invoices
  for each row when (new.zoho_invoice_id is null)
  execute function public.tg_network_invoice_issue();

commit;
