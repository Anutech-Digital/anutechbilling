-- deploy-peek: to_regclass('public.zoho_books_import_runs') is not null and to_regclass('public.zoho_books_import_records') is not null and to_regprocedure('public.zoho_books_import_apply(uuid,jsonb,jsonb,jsonb)') is not null and to_regprocedure('public.zoho_books_import_undo(uuid,text)') is not null
-- deploy-key: r1753zohobooksimport
--
-- R-1753 — "Import from Zoho" for a tenant that connected its own Zoho Books (R-1749):
-- customers, live subscriptions and open invoices, read-only from the chosen organization.
--
-- ══ FLOW ════════════════════════════════════════════════════════════════════════════════
--   1. Dry run: the server reads Zoho in small resumable steps (Zoho allows ~100 requests a
--      minute) into zoho_books_import_records — contacts, invoices and, for invoices in the
--      subscription window (default the last 24 months), their line items. The run row keeps
--      the cursor (phase + next page) so a closed browser continues where it stopped.
--      Nothing outside these two tables is written; the dry run shows counts + problems.
--   2. Import: zoho_books_import_apply() — ONE transaction (§17b): customers (matched again
--      here: GSTIN, then exact name; an existing customer is never changed), their contact
--      person, live subscriptions (skipped when that domain already has one), and open
--      invoices through R-1739's import_opening_invoices() (never GST / revenue). The run id
--      is the import's batch id; it records every row it created.
--   3. Undo: zoho_books_import_undo() — refused once anything touched the import (a payment
--      on an imported invoice, a quote / billing on an imported subscription, any other
--      record on a customer it created). Owner / accountant, like R-1739's Remove import.
--
-- Tenant isolation, fail closed (§17c): both functions take the tenant from the caller
-- (current_tenant_id()), refuse a NULL one, and only touch rows of that tenant; the run is
-- looked up by id AND tenant. Tables: RLS select own tenant (owner/manager/accountant),
-- writes only by the service role (the server routes) and these SECURITY DEFINER functions.
-- Test: supabase/tests/zoho_books_import_r1753.test.sql.

-- ── 1. Tables ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.zoho_books_import_runs (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references public.tenants(id) on delete cascade,
  org_id                   text        not null check (char_length(org_id) between 1 and 40),
  since                    date        not null,
  months                   integer     not null default 24 check (months between 1 and 120),
  phase                    text        not null default 'contacts'
                                       check (phase in ('contacts', 'invoices', 'details', 'ready')),
  next_page                integer     not null default 1 check (next_page >= 1),
  contacts_read            integer     not null default 0 check (contacts_read >= 0),
  invoices_read            integer     not null default 0 check (invoices_read >= 0),
  details_total            integer     not null default 0 check (details_total >= 0),
  details_done             integer     not null default 0 check (details_done >= 0),
  last_error               text        check (last_error is null or char_length(last_error) <= 500),
  started_by               uuid        references public.users(id) on delete set null,
  started_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  scanned_at               timestamptz,
  imported_at              timestamptz,
  imported_by              uuid        references public.users(id) on delete set null,
  result                   jsonb,
  created_customer_ids     uuid[]      not null default '{}',
  created_contact_ids      text[]      not null default '{}',
  created_subscription_ids uuid[]      not null default '{}',
  invoice_batch_id         uuid        references public.invoice_import_batches(id) on delete set null,
  undone_at                timestamptz,
  undone_by                uuid        references public.users(id) on delete set null,
  undo_reason              text        check (undo_reason is null or char_length(undo_reason) <= 500),
  unique (id, tenant_id)
);
comment on table public.zoho_books_import_runs is
  'R-1753: one "Import from Zoho" run per row — the dry-run cursor while reading Zoho, then the import batch (ids of every row it created) and its undo.';

-- One unfinished (not imported) run per company: a new dry run replaces it.
create unique index if not exists zoho_books_import_runs_one_open
  on public.zoho_books_import_runs (tenant_id) where imported_at is null;
create index if not exists zoho_books_import_runs_tenant_idx
  on public.zoho_books_import_runs (tenant_id, started_at desc);

create table if not exists public.zoho_books_import_records (
  run_id       uuid        not null,
  tenant_id    uuid        not null,
  kind         text        not null check (kind in ('contact', 'invoice')),
  zoho_id      text        not null check (char_length(zoho_id) between 1 and 40),
  data         jsonb       not null,
  /* invoice line items; null = not read (yet) */
  lines        jsonb,
  needs_detail boolean     not null default false,
  read_at      timestamptz not null default now(),
  primary key (run_id, kind, zoho_id),
  foreign key (run_id, tenant_id) references public.zoho_books_import_runs(id, tenant_id) on delete cascade
);
comment on table public.zoho_books_import_records is
  'R-1753: what a dry run read from Zoho Books (contacts, invoices + line items). Deleted when the run is imported or replaced.';
create index if not exists zoho_books_import_records_pending
  on public.zoho_books_import_records (run_id) where needs_detail and lines is null;

do $$
declare t text;
begin
  foreach t in array array['zoho_books_import_runs', 'zoho_books_import_records'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($p$create policy %I on public.%I as permissive for select to authenticated
                     using (tenant_id = (select public.current_tenant_id())
                            and public.current_user_has_role('owner', 'manager', 'accountant'))$p$, t || '_select', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

-- ── 2. Import ─────────────────────────────────────────────────────────────────────────────
create or replace function public.zoho_books_import_apply(
  p_run_id uuid, p_customers jsonb, p_subscriptions jsonb, p_invoices jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1753 */
  v_tenant      uuid := public.current_tenant_id();
  v_run         public.zoho_books_import_runs;
  v_map         jsonb := '{}'::jsonb;   -- Zoho contact id → our customer id
  v_row         jsonb;
  v_zid         text;
  v_name        text;
  v_gstin       text;
  v_email       text;
  v_n           integer;
  v_id          uuid;
  v_contact     text;
  v_domain      text;
  v_cust_name   text;
  v_new_cust    uuid[] := '{}';
  v_new_contact text[] := '{}';
  v_new_subs    uuid[] := '{}';
  v_existing    integer := 0;
  v_ambiguous   jsonb := '[]'::jsonb;
  v_sub_already integer := 0;
  v_sub_nocust  integer := 0;
  v_inv_nocust  integer := 0;
  v_inv_rows    jsonb := '[]'::jsonb;
  v_inv         jsonb;
  v_mrr         bigint := 0;
  v_result      jsonb;
begin
  if v_tenant is null then
    raise exception 'Importing from Zoho needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can import from Zoho Books.'
      using errcode = '42501';
  end if;
  select * into v_run from public.zoho_books_import_runs
   where id = p_run_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'That Zoho dry run was not found. Run the dry run again.' using errcode = 'P0002';
  end if;
  if v_run.imported_at is not null then
    raise exception 'This dry run was already imported on %. Run a new dry run to import again.',
      to_char(v_run.imported_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
  end if;
  if v_run.phase <> 'ready' then
    raise exception 'Reading from Zoho is not finished yet. Continue the dry run, then import.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_customers, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_subscriptions, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_invoices, '[]'::jsonb)) <> 'array' then
    raise exception 'The import data is not in the expected shape. Run the dry run again.' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_customers, '[]'::jsonb)) > 20000
     or jsonb_array_length(coalesce(p_subscriptions, '[]'::jsonb)) > 20000 then
    raise exception 'Too many rows in one import.' using errcode = '22023';
  end if;

  -- ── Customers: GSTIN, then exact name; existing ones are matched, never changed ──
  for v_row in select value from jsonb_array_elements(coalesce(p_customers, '[]'::jsonb)) loop
    v_zid   := btrim(coalesce(v_row->>'zoho_id', ''));
    v_name  := btrim(regexp_replace(coalesce(v_row->>'name', ''), '\s+', ' ', 'g'));
    v_gstin := nullif(upper(btrim(coalesce(v_row->>'gstin', ''))), '');
    if v_zid = '' or v_name = '' or char_length(v_name) > 300 then
      raise exception 'A Zoho contact has no name (or a name over 300 characters). Run the dry run again.' using errcode = '22023';
    end if;
    v_id := null;
    if v_gstin is not null then
      select count(*), (array_agg(c.id))[1] into v_n, v_id
        from public.customers c
       where c.tenant_id = v_tenant and upper(btrim(c.gstin)) = v_gstin;
      if v_n > 1 then
        v_ambiguous := v_ambiguous || to_jsonb(v_name);
        continue;
      end if;
    end if;
    if v_id is null then
      select count(*), (array_agg(c.id))[1] into v_n, v_id
        from public.customers c
       where c.tenant_id = v_tenant
         and lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) = lower(v_name);
      if v_n > 1 then
        v_ambiguous := v_ambiguous || to_jsonb(v_name);
        continue;
      end if;
    end if;
    if v_id is not null then
      if not (v_id = any (v_new_cust)) then v_existing := v_existing + 1; end if;
      v_map := v_map || jsonb_build_object(v_zid, v_id);
      continue;
    end if;

    insert into public.customers (
      tenant_id, name, gstin, gst_treatment, state, state_code, payment_terms_days, customer_type,
      contact_name, contact_email, contact_phone, since)
    values (
      v_tenant, v_name, v_gstin,
      nullif(v_row->>'gst_treatment', ''),
      nullif(btrim(coalesce(v_row->>'state', '')), ''),
      nullif(btrim(coalesce(v_row->>'state_code', '')), ''),
      nullif(v_row->>'payment_terms_days', '')::integer,
      case when v_row->>'customer_type' = 'individual' then 'individual' else 'business' end,
      nullif(btrim(coalesce(v_row->>'contact_name', '')), ''),
      nullif(btrim(coalesce(v_row->>'contact_email', '')), ''),
      nullif(btrim(coalesce(v_row->>'contact_phone', '')), ''),
      nullif(v_row->>'since', '')::date)
    returning id into v_id;
    v_new_cust := v_new_cust || v_id;
    v_map := v_map || jsonb_build_object(v_zid, v_id);

    -- The contact person: the same person by email is linked, never duplicated.
    if nullif(btrim(coalesce(v_row->>'contact_name', '')), '') is not null then
      v_email := nullif(lower(btrim(coalesce(v_row->>'contact_email', ''))), '');
      v_contact := null;
      if v_email is not null then
        select ct.id into v_contact from public.contacts ct
         where ct.tenant_id = v_tenant and lower(ct.email) = v_email limit 1;
      end if;
      if v_contact is null then
        v_contact := 'C-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
        insert into public.contacts (id, tenant_id, customer_id, full_name, email, phone, company, role, is_primary, source, status)
        values (v_contact, v_tenant, v_id, btrim(v_row->>'contact_name'), v_email,
                nullif(btrim(coalesce(v_row->>'contact_phone', '')), ''), v_name, 'poc', true, 'other', 'engaged');
        v_new_contact := v_new_contact || v_contact;
      end if;
      insert into public.customer_contacts (tenant_id, customer_id, contact_id, role, is_primary)
      values (v_tenant, v_id, v_contact, 'poc', true);
    end if;
  end loop;

  -- ── Live subscriptions (skipped when that domain already has one here) ──
  for v_row in select value from jsonb_array_elements(coalesce(p_subscriptions, '[]'::jsonb)) loop
    v_id := nullif(v_map->>btrim(coalesce(v_row->>'zoho_customer_id', '')), '')::uuid;
    if v_id is null then
      v_sub_nocust := v_sub_nocust + 1;
      continue;
    end if;
    v_domain := lower(regexp_replace(regexp_replace(btrim(coalesce(v_row->>'domain', '')), '^https?://', ''), '^www\.', ''));
    if v_domain = '' then
      raise exception 'A subscription has no domain. Run the dry run again.' using errcode = '22023';
    end if;
    if exists (select 1 from public.subscriptions s
                where s.tenant_id = v_tenant
                  and not (s.id = any (v_new_subs))
                  and lower(regexp_replace(regexp_replace(btrim(coalesce(s.domain, '')), '^https?://', ''), '^www\.', '')) = v_domain) then
      v_sub_already := v_sub_already + 1;
      continue;
    end if;
    if coalesce((v_row->>'seats')::integer, 0) <= 0 or coalesce((v_row->>'mrr')::integer, -1) < 0
       or coalesce((v_row->>'term_months')::integer, 0) <= 0
       or nullif(v_row->>'renewal_date', '') is null or nullif(v_row->>'start_date', '') is null then
      raise exception 'Subscription % has no seats, price, term or dates. Run the dry run again.', v_domain using errcode = '22023';
    end if;
    select c.name into v_cust_name from public.customers c where c.id = v_id and c.tenant_id = v_tenant;
    insert into public.subscriptions (
      tenant_id, customer_id, customer_name, plan, vendor, seats, used, mrr, start_date, renewal_date,
      status, domain, outstanding_amount, auto_renew, billing_cycle, term_months)
    values (
      v_tenant, v_id, v_cust_name, left(btrim(v_row->>'plan'), 200),
      (case when v_row->>'vendor' in ('google', 'microsoft', 'zoho') then v_row->>'vendor' else 'other' end)::public.vendor,
      (v_row->>'seats')::integer, 0, (v_row->>'mrr')::integer,
      (v_row->>'start_date')::date, (v_row->>'renewal_date')::date,
      'active', v_domain, 0, true,
      (case when v_row->>'billing_cycle' in ('monthly', 'quarterly', 'half_yearly', 'yearly') then v_row->>'billing_cycle' else 'yearly' end)::public.billing_cycle,
      (v_row->>'term_months')::integer)
    returning id into v_id;
    v_new_subs := v_new_subs || v_id;
    v_mrr := v_mrr + (v_row->>'mrr')::integer;
  end loop;

  -- ── Open invoices: R-1739's own import (never GST / revenue) ──
  for v_row in select value from jsonb_array_elements(coalesce(p_invoices, '[]'::jsonb)) loop
    v_id := nullif(v_map->>btrim(coalesce(v_row->>'zoho_customer_id', '')), '')::uuid;
    if v_id is null then
      v_inv_nocust := v_inv_nocust + 1;
      continue;
    end if;
    v_inv_rows := v_inv_rows || jsonb_build_array((v_row - 'zoho_customer_id') || jsonb_build_object('customer_id', v_id));
  end loop;
  if jsonb_array_length(v_inv_rows) > 0 then
    v_inv := public.import_opening_invoices(v_inv_rows, 'Zoho Books (connected)');
  end if;

  v_result := jsonb_build_object(
    'batch_id', p_run_id,
    'customers_created', coalesce(array_length(v_new_cust, 1), 0),
    'customers_existing', v_existing,
    'customers_ambiguous', v_ambiguous,
    'contacts_created', coalesce(array_length(v_new_contact, 1), 0),
    'subscriptions_created', coalesce(array_length(v_new_subs, 1), 0),
    'subscriptions_already', v_sub_already,
    'subscriptions_no_customer', v_sub_nocust,
    'mrr', v_mrr,
    'invoices_imported', coalesce((v_inv->>'imported')::integer, 0),
    'invoices_skipped', coalesce(v_inv->'skipped', '[]'::jsonb),
    'invoices_no_customer', v_inv_nocust,
    'open_balance', coalesce((v_inv->>'total_balance')::bigint, 0),
    'invoice_batch_id', v_inv->'batch_id');

  update public.zoho_books_import_runs
     set imported_at = now(), imported_by = auth.uid(), updated_at = now(), result = v_result,
         created_customer_ids = v_new_cust, created_contact_ids = v_new_contact,
         created_subscription_ids = v_new_subs,
         invoice_batch_id = nullif(v_inv->>'batch_id', '')::uuid
   where id = p_run_id and tenant_id = v_tenant;
  -- What was read from Zoho is not kept once it is imported.
  delete from public.zoho_books_import_records where run_id = p_run_id and tenant_id = v_tenant;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_books.imported', 'zoho_books_import', p_run_id::text,
          left(format('Imported from Zoho Books: %s customers, %s subscriptions, %s open invoices',
                      coalesce(array_length(v_new_cust, 1), 0), coalesce(array_length(v_new_subs, 1), 0),
                      coalesce((v_inv->>'imported')::integer, 0)), 120),
          v_result);
  return v_result;
end;
$function$;

comment on function public.zoho_books_import_apply(uuid, jsonb, jsonb, jsonb) is
  'R-1753: one atomic Zoho Books import for the caller''s tenant — customers (GSTIN then exact name; existing never changed), contact person, live subscriptions (domain already here → skipped), open invoices via import_opening_invoices. Owner/manager/accountant.';
revoke all on function public.zoho_books_import_apply(uuid, jsonb, jsonb, jsonb) from public;
revoke all on function public.zoho_books_import_apply(uuid, jsonb, jsonb, jsonb) from anon;
grant execute on function public.zoho_books_import_apply(uuid, jsonb, jsonb, jsonb) to authenticated, service_role;

-- ── 3. Undo ───────────────────────────────────────────────────────────────────────────────
create or replace function public.zoho_books_import_undo(p_run_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1753 */
  v_tenant uuid := public.current_tenant_id();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_run    public.zoho_books_import_runs;
  v_bad    text;
  v_subs   integer;
  v_custs  integer;
  v_inv    jsonb;
  v_result jsonb;
begin
  if v_tenant is null then
    raise exception 'Undoing an import needs an active user who has finished sign-in. Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant can undo an import. Ask one of them to do it.'
      using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'Write why you are undoing this import (at least 3 characters) — it goes in the activity log.'
      using errcode = '22023';
  end if;
  select * into v_run from public.zoho_books_import_runs
   where id = p_run_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'That import was not found. Refresh the page.' using errcode = 'P0002';
  end if;
  if v_run.imported_at is null then
    raise exception 'This dry run was never imported — nothing to undo.' using errcode = 'P0001';
  end if;
  if v_run.undone_at is not null then
    raise exception 'This import was already undone on %.',
      to_char(v_run.undone_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
  end if;

  -- Subscriptions that something has used since.
  select string_agg(coalesce(s.domain, s.plan), ', ') into v_bad
    from (select s.* from public.subscriptions s
           where s.tenant_id = v_tenant and s.id = any (v_run.created_subscription_ids)
             and (s.quote_id is not null or s.renewal_quote_id is not null
               or exists (select 1 from public.quotes q where q.renewal_subscription_id = s.id or q.add_seats_subscription_id = s.id)
               or exists (select 1 from public.subscription_billings b where b.subscription_id = s.id)
               or exists (select 1 from public.seat_requests r where r.subscription_id = s.id)
               or exists (select 1 from public.payment_mandates m where m.subscription_id = s.id)
               or exists (select 1 from public.purchase_orders po where po.subscription_id = s.id))
           limit 10) s;
  if v_bad is not null then
    raise exception 'This import cannot be undone: a quote, bill or seat change already uses the subscription for %. Undo that first.', v_bad
      using errcode = 'P0001';
  end if;

  -- Customers it created that now have other records.
  select string_agg(c.name, ', ') into v_bad
    from (select c.* from public.customers c
           where c.tenant_id = v_tenant and c.id = any (v_run.created_customer_ids)
             and (exists (select 1 from public.invoices i where i.customer_id = c.id
                           and i.import_batch_id is distinct from v_run.invoice_batch_id)
               or exists (select 1 from public.quotes q where q.customer_id = c.id)
               or exists (select 1 from public.payments p where p.customer_id = c.id)
               or exists (select 1 from public.credit_notes n where n.customer_id = c.id)
               or exists (select 1 from public.debit_notes n where n.customer_id = c.id)
               or exists (select 1 from public.project_sales ps where ps.customer_id = c.id)
               or exists (select 1 from public.tds_receivable t where t.customer_id = c.id)
               or exists (select 1 from public.customer_credits cc where cc.customer_id = c.id)
               or exists (select 1 from public.subscriptions s where s.customer_id = c.id
                           and not (s.id = any (v_run.created_subscription_ids))))
           limit 10) c;
  if v_bad is not null then
    raise exception 'This import cannot be undone: % already has a quote, invoice, payment or subscription made after the import. Delete that first.', v_bad
      using errcode = 'P0001';
  end if;

  -- Open invoices: R-1739's own removal (refuses once a payment, TDS or note touches one).
  if v_run.invoice_batch_id is not null
     and exists (select 1 from public.invoice_import_batches b where b.id = v_run.invoice_batch_id and b.removed_at is null) then
    v_inv := public.remove_opening_invoice_import(v_run.invoice_batch_id, 'Zoho Books import undone: ' || v_reason);
  end if;

  delete from public.subscriptions
   where tenant_id = v_tenant and id = any (v_run.created_subscription_ids);
  get diagnostics v_subs = row_count;
  delete from public.customers
   where tenant_id = v_tenant and id = any (v_run.created_customer_ids);
  get diagnostics v_custs = row_count;
  delete from public.contacts ct
   where ct.tenant_id = v_tenant and ct.id = any (v_run.created_contact_ids)
     and not exists (select 1 from public.customer_contacts cc where cc.contact_id = ct.id);

  v_result := jsonb_build_object('batch_id', p_run_id, 'subscriptions_removed', v_subs, 'customers_removed', v_custs,
                                 'invoices_removed', coalesce((v_inv->>'removed')::integer, 0));
  update public.zoho_books_import_runs
     set undone_at = now(), undone_by = auth.uid(), undo_reason = left(v_reason, 500), updated_at = now()
   where id = p_run_id and tenant_id = v_tenant;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_books.import_undone', 'zoho_books_import', p_run_id::text,
          left(format('Undid Zoho Books import: %s customers, %s subscriptions, %s invoices — %s',
                      v_custs, v_subs, coalesce((v_inv->>'removed')::integer, 0), v_reason), 120),
          v_result || jsonb_build_object('reason', v_reason));
  return v_result;
end;
$function$;

comment on function public.zoho_books_import_undo(uuid, text) is
  'R-1753: takes back one Zoho Books import (customers, contacts, subscriptions it created + its opening invoices) while nothing has used them. Owner/accountant.';
revoke all on function public.zoho_books_import_undo(uuid, text) from public;
revoke all on function public.zoho_books_import_undo(uuid, text) from anon;
grant execute on function public.zoho_books_import_undo(uuid, text) to authenticated, service_role;
