-- deploy-peek: to_regprocedure('public.zoho_books_import_begin(uuid,jsonb,jsonb,jsonb)') is not null and to_regprocedure('public.zoho_books_import_step(uuid,integer)') is not null and exists(select 1 from pg_proc where proname = 'zoho_books_import_undo' and prosrc like '%R-1760%')
-- deploy-key: r1760zohoimportinparts
--
-- R-1760 — "Import from Zoho" in parts, so no single call meets the 8-second statement
-- timeout of the signed-in user's role (authenticated / authenticator: statement_timeout=8s).
--
-- Measured 22 Oct on the local DB: R-1753's zoho_books_import_apply() with 1,300 customers,
-- 1,400 subscriptions and 250 open invoices took 8.7 s in ONE statement (customers alone
-- 2.9 s) — the owner's real dry run (1,245 / 1,371 / 246) failed with "canceling statement due
-- to statement timeout" and nothing was imported.
--
-- ══ FLOW ════════════════════════════════════════════════════════════════════════════════
--   1. zoho_books_import_begin(run, customers, subscriptions, invoices) — keeps the plan the
--      dry run showed ON THE RUN (frozen: later parts never re-plan against rows the earlier
--      parts created) and sets the cursor: stage 'customers', offset 0. Calling it again on a
--      run already begun changes nothing (returns the progress).
--   2. zoho_books_import_step(run, limit) — applies the next part (≤ limit rows of the current
--      stage) in ONE transaction and moves the cursor in that same transaction, so a part that
--      fails leaves nothing behind and is simply tried again. Each part appends what it created
--      to the run (created_customer_ids / created_contact_ids / created_subscription_ids /
--      invoice_batch_ids) and keeps Zoho contact id → our customer id in import_map, so
--      subscriptions and invoices of later parts find customers created by earlier parts. A
--      Zoho contact already in import_map is never created again. After the last invoice part
--      the import is finished: imported_at, result, what was read from Zoho deleted.
--   3. zoho_books_import_undo — as R-1753, plus: removes every invoice batch of the import, and
--      takes back a half-finished import too (so a stuck import never blocks a new dry run).
--
-- Matching inside a part is set-based: one query per part reads the customers whose GSTIN /
-- name the part contains (not one table scan per row), one query reads the domains already
-- here. Tenant and role rules are R-1753's exactly: the tenant is current_tenant_id(), NULL
-- refused; owner / manager / accountant import, owner / accountant undo; the run is looked up
-- by id AND tenant. Test: supabase/tests/zoho_books_import_parts_r1760.test.sql.

-- ── 1. The cursor and the frozen plan on the run ──────────────────────────────────────────
alter table public.zoho_books_import_runs
  add column if not exists import_stage      text,
  add column if not exists import_offset     integer     not null default 0,
  add column if not exists import_plan       jsonb,
  add column if not exists import_map        jsonb       not null default '{}'::jsonb,
  add column if not exists import_tally      jsonb       not null default '{}'::jsonb,
  add column if not exists invoice_batch_ids uuid[]      not null default '{}',
  add column if not exists import_started_at timestamptz,
  add column if not exists undo_started_at   timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'zoho_books_import_runs_import_stage_check') then
    alter table public.zoho_books_import_runs
      add constraint zoho_books_import_runs_import_stage_check
      check (import_stage is null or import_stage in ('customers', 'subscriptions', 'invoices', 'done'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'zoho_books_import_runs_import_offset_check') then
    alter table public.zoho_books_import_runs
      add constraint zoho_books_import_runs_import_offset_check check (import_offset >= 0);
  end if;
end $$;

comment on column public.zoho_books_import_runs.import_stage is
  'R-1760: where the import in parts stands — customers → subscriptions → invoices → done; null = not started.';
comment on column public.zoho_books_import_runs.import_plan is
  'R-1760: the plan the dry run showed (customers / subscriptions / invoices), frozen when Import was pressed; cleared when the import finishes.';
comment on column public.zoho_books_import_runs.import_map is
  'R-1760: Zoho contact id → our customer id, filled by the customer parts; later parts resolve through it.';

-- ── 2. Progress, as the screen shows it ───────────────────────────────────────────────────
create or replace function public.zoho_books_import_progress(p_run public.zoho_books_import_runs)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  /* R-1760 */
  select jsonb_build_object(
    'run_id', p_run.id,
    'stage', p_run.import_stage,
    'offset', p_run.import_offset,
    'totals', coalesce(p_run.import_tally->'totals', jsonb_build_object('customers', 0, 'subscriptions', 0, 'invoices', 0)),
    'done', p_run.imported_at is not null,
    'undo_started_at', p_run.undo_started_at,
    'result', p_run.result);
$function$;
revoke all on function public.zoho_books_import_progress(public.zoho_books_import_runs) from public;
revoke all on function public.zoho_books_import_progress(public.zoho_books_import_runs) from anon;
grant execute on function public.zoho_books_import_progress(public.zoho_books_import_runs) to authenticated, service_role;

-- ── 3. Begin: freeze the plan, set the cursor ─────────────────────────────────────────────
create or replace function public.zoho_books_import_begin(
  p_run_id uuid, p_customers jsonb, p_subscriptions jsonb, p_invoices jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1760 */
  v_tenant uuid := public.current_tenant_id();
  v_run    public.zoho_books_import_runs;
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
  -- Already begun: the plan stays as it was frozen; the cursor is not reset.
  if v_run.import_stage is not null then
    return public.zoho_books_import_progress(v_run);
  end if;
  if jsonb_typeof(coalesce(p_customers, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_subscriptions, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_invoices, '[]'::jsonb)) <> 'array' then
    raise exception 'The import data is not in the expected shape. Run the dry run again.' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_customers, '[]'::jsonb)) > 20000
     or jsonb_array_length(coalesce(p_subscriptions, '[]'::jsonb)) > 20000
     or jsonb_array_length(coalesce(p_invoices, '[]'::jsonb)) > 5000 then
    raise exception 'Too many rows in one import.' using errcode = '22023';
  end if;

  update public.zoho_books_import_runs
     set import_stage = 'customers', import_offset = 0, import_started_at = now(), updated_at = now(),
         import_plan = jsonb_build_object(
           'customers', coalesce(p_customers, '[]'::jsonb),
           'subscriptions', coalesce(p_subscriptions, '[]'::jsonb),
           'invoices', coalesce(p_invoices, '[]'::jsonb)),
         import_map = '{}'::jsonb,
         import_tally = jsonb_build_object(
           'totals', jsonb_build_object(
             'customers', jsonb_array_length(coalesce(p_customers, '[]'::jsonb)),
             'subscriptions', jsonb_array_length(coalesce(p_subscriptions, '[]'::jsonb)),
             'invoices', jsonb_array_length(coalesce(p_invoices, '[]'::jsonb))),
           'customers_existing', 0, 'customers_ambiguous', '[]'::jsonb,
           'subscriptions_already', 0, 'subscriptions_no_customer', 0, 'mrr', 0,
           'invoices_imported', 0, 'invoices_skipped', '[]'::jsonb, 'invoices_no_customer', 0, 'open_balance', 0),
         created_customer_ids = '{}', created_contact_ids = '{}', created_subscription_ids = '{}',
         invoice_batch_ids = '{}', invoice_batch_id = null, last_error = null
   where id = p_run_id and tenant_id = v_tenant
  returning * into v_run;
  return public.zoho_books_import_progress(v_run);
end;
$function$;

comment on function public.zoho_books_import_begin(uuid, jsonb, jsonb, jsonb) is
  'R-1760: starts the Zoho Books import in parts — freezes the dry-run plan on the run and sets the cursor (customers, 0). Again on a begun run: no change. Owner/manager/accountant; tenant from current_tenant_id().';
revoke all on function public.zoho_books_import_begin(uuid, jsonb, jsonb, jsonb) from public;
revoke all on function public.zoho_books_import_begin(uuid, jsonb, jsonb, jsonb) from anon;
grant execute on function public.zoho_books_import_begin(uuid, jsonb, jsonb, jsonb) to authenticated, service_role;

-- ── 4. Step: one part, atomically, cursor moved in the same transaction ───────────────────
create or replace function public.zoho_books_import_step(p_run_id uuid, p_limit integer default 150)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1760 */
  v_tenant      uuid := public.current_tenant_id();
  v_run         public.zoho_books_import_runs;
  v_lim         integer := greatest(1, least(coalesce(p_limit, 150), 500));
  v_stage       text;
  v_off         integer;
  v_total       integer;
  v_part        jsonb;
  v_map         jsonb;
  v_tally       jsonb;
  v_by_gstin    jsonb;
  v_by_name     jsonb;
  v_domains     jsonb;
  v_ids         jsonb;
  v_row         jsonb;
  v_zid         text;
  v_name        text;
  v_nk          text;
  v_gstin       text;
  v_email       text;
  v_id          uuid;
  v_contact     text;
  v_domain      text;
  v_cust_name   text;
  v_new_cust    uuid[];
  v_new_contact text[];
  v_new_subs    uuid[];
  v_batches     uuid[];
  v_inv_rows    jsonb := '[]'::jsonb;
  v_inv         jsonb;
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
  if v_run.undone_at is not null then
    raise exception 'This import was undone. Run a new dry run to import again.' using errcode = 'P0001';
  end if;
  if v_run.undo_started_at is not null then
    raise exception 'This import is being undone. Press Undo import to finish removing it.' using errcode = 'P0001';
  end if;
  -- Finished already (e.g. the answer to the last part was lost): the same answer again.
  if v_run.imported_at is not null then
    return public.zoho_books_import_progress(v_run);
  end if;
  if v_run.import_stage is null or v_run.import_plan is null then
    raise exception 'The import has not started. Press Import.' using errcode = 'P0001';
  end if;

  v_stage       := v_run.import_stage;
  v_off         := v_run.import_offset;
  v_map         := v_run.import_map;
  v_tally       := v_run.import_tally;
  v_new_cust    := v_run.created_customer_ids;
  v_new_contact := v_run.created_contact_ids;
  v_new_subs    := v_run.created_subscription_ids;
  v_batches     := v_run.invoice_batch_ids;
  v_total       := coalesce(jsonb_array_length(v_run.import_plan->v_stage), 0);

  if v_stage <> 'done' and v_off < v_total then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb) into v_part
      from jsonb_array_elements(v_run.import_plan->v_stage) with ordinality t(value, ord)
     where t.ord > v_off and t.ord <= v_off + v_lim;

    -- ── Customers: GSTIN, then exact name; existing ones are matched, never changed ──
    if v_stage = 'customers' then
      -- Customers here whose GSTIN / name this part has — one query each, not one per row.
      select coalesce(jsonb_object_agg(x.k, x.ids), '{}'::jsonb) into v_by_gstin
        from (select upper(btrim(c.gstin)) k, jsonb_agg(c.id) ids
                from public.customers c
               where c.tenant_id = v_tenant
                 and upper(btrim(c.gstin)) in (select nullif(upper(btrim(coalesce(p.value->>'gstin', ''))), '')
                                                 from jsonb_array_elements(v_part) p)
               group by 1) x;
      select coalesce(jsonb_object_agg(x.k, x.ids), '{}'::jsonb) into v_by_name
        from (select lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) k, jsonb_agg(c.id) ids
                from public.customers c
               where c.tenant_id = v_tenant
                 and lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) in
                     (select lower(btrim(regexp_replace(coalesce(p.value->>'name', ''), '\s+', ' ', 'g')))
                        from jsonb_array_elements(v_part) p)
               group by 1) x;

      for v_row in select value from jsonb_array_elements(v_part) loop
        v_zid   := btrim(coalesce(v_row->>'zoho_id', ''));
        v_name  := btrim(regexp_replace(coalesce(v_row->>'name', ''), '\s+', ' ', 'g'));
        v_nk    := lower(v_name);
        v_gstin := nullif(upper(btrim(coalesce(v_row->>'gstin', ''))), '');
        if v_zid = '' or v_name = '' or char_length(v_name) > 300 then
          raise exception 'A Zoho contact has no name (or a name over 300 characters). Run the dry run again.' using errcode = '22023';
        end if;
        -- Done in an earlier part: never twice.
        if v_map ? v_zid then continue; end if;
        v_id := null;
        if v_gstin is not null then
          v_ids := coalesce(v_by_gstin->v_gstin, '[]'::jsonb);
          if jsonb_array_length(v_ids) > 1 then
            v_tally := jsonb_set(v_tally, '{customers_ambiguous}', coalesce(v_tally->'customers_ambiguous', '[]'::jsonb) || to_jsonb(v_name));
            continue;
          elsif jsonb_array_length(v_ids) = 1 then
            v_id := (v_ids->>0)::uuid;
          end if;
        end if;
        if v_id is null then
          v_ids := coalesce(v_by_name->v_nk, '[]'::jsonb);
          if jsonb_array_length(v_ids) > 1 then
            v_tally := jsonb_set(v_tally, '{customers_ambiguous}', coalesce(v_tally->'customers_ambiguous', '[]'::jsonb) || to_jsonb(v_name));
            continue;
          elsif jsonb_array_length(v_ids) = 1 then
            v_id := (v_ids->>0)::uuid;
          end if;
        end if;
        if v_id is not null then
          if not (v_id = any (v_new_cust)) then
            v_tally := jsonb_set(v_tally, '{customers_existing}', to_jsonb(coalesce((v_tally->>'customers_existing')::integer, 0) + 1));
          end if;
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
        -- A later Zoho contact with the same GSTIN / name matches this one, as in R-1753.
        if v_gstin is not null then
          v_by_gstin := v_by_gstin || jsonb_build_object(v_gstin, coalesce(v_by_gstin->v_gstin, '[]'::jsonb) || to_jsonb(v_id));
        end if;
        v_by_name := v_by_name || jsonb_build_object(v_nk, coalesce(v_by_name->v_nk, '[]'::jsonb) || to_jsonb(v_id));

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
    elsif v_stage = 'subscriptions' then
      -- Domains of this part that already have a subscription not made by this import.
      select coalesce(jsonb_object_agg(x.d, true), '{}'::jsonb) into v_domains
        from (select distinct lower(regexp_replace(regexp_replace(btrim(coalesce(s.domain, '')), '^https?://', ''), '^www\.', '')) d
                from public.subscriptions s
               where s.tenant_id = v_tenant
                 and not exists (select 1 from unnest(v_new_subs) n(id) where n.id = s.id)
                 and lower(regexp_replace(regexp_replace(btrim(coalesce(s.domain, '')), '^https?://', ''), '^www\.', '')) in
                     (select lower(regexp_replace(regexp_replace(btrim(coalesce(p.value->>'domain', '')), '^https?://', ''), '^www\.', ''))
                        from jsonb_array_elements(v_part) p)) x;

      for v_row in select value from jsonb_array_elements(v_part) loop
        v_id := nullif(v_map->>btrim(coalesce(v_row->>'zoho_customer_id', '')), '')::uuid;
        if v_id is null then
          v_tally := jsonb_set(v_tally, '{subscriptions_no_customer}', to_jsonb(coalesce((v_tally->>'subscriptions_no_customer')::integer, 0) + 1));
          continue;
        end if;
        v_domain := lower(regexp_replace(regexp_replace(btrim(coalesce(v_row->>'domain', '')), '^https?://', ''), '^www\.', ''));
        if v_domain = '' then
          raise exception 'A subscription has no domain. Run the dry run again.' using errcode = '22023';
        end if;
        if v_domains ? v_domain then
          v_tally := jsonb_set(v_tally, '{subscriptions_already}', to_jsonb(coalesce((v_tally->>'subscriptions_already')::integer, 0) + 1));
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
        v_tally := jsonb_set(v_tally, '{mrr}', to_jsonb(coalesce((v_tally->>'mrr')::bigint, 0) + (v_row->>'mrr')::integer));
      end loop;

    -- ── Open invoices: R-1739's own import (never GST / revenue), one batch per part ──
    elsif v_stage = 'invoices' then
      for v_row in select value from jsonb_array_elements(v_part) loop
        v_id := nullif(v_map->>btrim(coalesce(v_row->>'zoho_customer_id', '')), '')::uuid;
        if v_id is null then
          v_tally := jsonb_set(v_tally, '{invoices_no_customer}', to_jsonb(coalesce((v_tally->>'invoices_no_customer')::integer, 0) + 1));
          continue;
        end if;
        v_inv_rows := v_inv_rows || jsonb_build_array((v_row - 'zoho_customer_id') || jsonb_build_object('customer_id', v_id));
      end loop;
      if jsonb_array_length(v_inv_rows) > 0 then
        v_inv := public.import_opening_invoices(v_inv_rows, 'Zoho Books (connected)');
        v_batches := v_batches || (v_inv->>'batch_id')::uuid;
        v_tally := v_tally || jsonb_build_object(
          'invoices_imported', coalesce((v_tally->>'invoices_imported')::integer, 0) + coalesce((v_inv->>'imported')::integer, 0),
          'invoices_skipped', coalesce(v_tally->'invoices_skipped', '[]'::jsonb) || coalesce(v_inv->'skipped', '[]'::jsonb),
          'open_balance', coalesce((v_tally->>'open_balance')::bigint, 0) + coalesce((v_inv->>'total_balance')::bigint, 0));
      end if;
    end if;

    v_off := v_off + jsonb_array_length(v_part);
  end if;

  -- Move on past every finished (or empty) stage.
  while v_stage <> 'done' and v_off >= coalesce(jsonb_array_length(v_run.import_plan->v_stage), 0) loop
    v_stage := case v_stage when 'customers' then 'subscriptions' when 'subscriptions' then 'invoices' else 'done' end;
    v_off := 0;
  end loop;

  update public.zoho_books_import_runs
     set import_stage = v_stage, import_offset = v_off, import_map = v_map, import_tally = v_tally,
         created_customer_ids = v_new_cust, created_contact_ids = v_new_contact,
         created_subscription_ids = v_new_subs, invoice_batch_ids = v_batches,
         invoice_batch_id = v_batches[1], last_error = null, updated_at = now()
   where id = p_run_id and tenant_id = v_tenant;

  if v_stage = 'done' then
    v_result := jsonb_build_object(
      'batch_id', p_run_id,
      'customers_created', coalesce(array_length(v_new_cust, 1), 0),
      'customers_existing', coalesce((v_tally->>'customers_existing')::integer, 0),
      'customers_ambiguous', coalesce(v_tally->'customers_ambiguous', '[]'::jsonb),
      'contacts_created', coalesce(array_length(v_new_contact, 1), 0),
      'subscriptions_created', coalesce(array_length(v_new_subs, 1), 0),
      'subscriptions_already', coalesce((v_tally->>'subscriptions_already')::integer, 0),
      'subscriptions_no_customer', coalesce((v_tally->>'subscriptions_no_customer')::integer, 0),
      'mrr', coalesce((v_tally->>'mrr')::bigint, 0),
      'invoices_imported', coalesce((v_tally->>'invoices_imported')::integer, 0),
      'invoices_skipped', coalesce(v_tally->'invoices_skipped', '[]'::jsonb),
      'invoices_no_customer', coalesce((v_tally->>'invoices_no_customer')::integer, 0),
      'open_balance', coalesce((v_tally->>'open_balance')::bigint, 0),
      'invoice_batch_id', to_jsonb(v_batches[1]),
      'invoice_batch_ids', to_jsonb(v_batches));
    update public.zoho_books_import_runs
       set imported_at = now(), imported_by = auth.uid(), result = v_result, import_plan = null, updated_at = now()
     where id = p_run_id and tenant_id = v_tenant;
    -- What was read from Zoho is not kept once it is imported.
    delete from public.zoho_books_import_records where run_id = p_run_id and tenant_id = v_tenant;
    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (v_tenant, auth.uid(), 'zoho_books.imported', 'zoho_books_import', p_run_id::text,
            left(format('Imported from Zoho Books: %s customers, %s subscriptions, %s open invoices',
                        coalesce(array_length(v_new_cust, 1), 0), coalesce(array_length(v_new_subs, 1), 0),
                        coalesce((v_tally->>'invoices_imported')::integer, 0)), 120),
            v_result);
  end if;

  select * into v_run from public.zoho_books_import_runs where id = p_run_id and tenant_id = v_tenant;
  return public.zoho_books_import_progress(v_run);
end;
$function$;

comment on function public.zoho_books_import_step(uuid, integer) is
  'R-1760: imports the next part (≤ p_limit rows, default 150, at most 500) of a begun Zoho Books import and moves the cursor in the same transaction; a Zoho contact already imported is never created again. Finishes the import after the last part. Owner/manager/accountant; tenant from current_tenant_id().';
revoke all on function public.zoho_books_import_step(uuid, integer) from public;
revoke all on function public.zoho_books_import_step(uuid, integer) from anon;
grant execute on function public.zoho_books_import_step(uuid, integer) to authenticated, service_role;

-- ── 5. Undo, in parts too: every invoice batch of the import; a half-finished import too ──
-- From R-1753's definition (20261022080501), the latest. Changes marked R-1760.
-- Measured 22 Oct: removing 1,301 customers + 1,401 subscriptions in one statement took 4.7 s
-- here (each deleted row writes its activity-log line) — too close to the 8 s timeout. So one
-- call removes what fits in ~2.5 s and answers done = false; the screen calls again until
-- done = true. The refusal checks run on every call, before anything is removed.
create or replace function public.zoho_books_import_undo(p_run_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1753, R-1760 */
  v_tenant  uuid := public.current_tenant_id();
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_run     public.zoho_books_import_runs;
  v_bad     text;
  v_t0      timestamptz := clock_timestamp();
  v_n       integer;
  v_subs    integer;
  v_custs   integer;
  v_inv_n   integer;
  v_chunk   uuid[];
  v_batches uuid[];
  v_batch   uuid;
  v_inv     jsonb;
  v_tally   jsonb;
  v_done    boolean := false;
  v_result  jsonb;
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
  -- R-1760: a half-finished import (begun, not finished) can be undone as well.
  if v_run.imported_at is null and v_run.import_stage is null then
    raise exception 'This dry run was never imported — nothing to undo.' using errcode = 'P0001';
  end if;
  if v_run.undone_at is not null then
    raise exception 'This import was already undone on %.',
      to_char(v_run.undone_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
  end if;
  -- R-1760: every part's invoice batch (R-1753 runs have only invoice_batch_id).
  select coalesce(array_agg(distinct b), '{}') into v_batches
    from unnest(v_run.invoice_batch_ids || v_run.invoice_batch_id) b where b is not null;

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
                           and (i.import_batch_id is null or not (i.import_batch_id = any (v_batches))))
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

  v_tally := coalesce(v_run.import_tally, '{}'::jsonb);
  v_inv_n := coalesce((v_tally->>'undo_invoices')::integer, 0);
  v_subs  := coalesce((v_tally->>'undo_subscriptions')::integer, 0);
  v_custs := coalesce((v_tally->>'undo_customers')::integer, 0);

  -- Remove in parts until done or ~2.5 s have gone (the next call continues).
  loop
    -- Open invoices: R-1739's own removal (refuses once a payment, TDS or note touches one).
    select b.id into v_batch from public.invoice_import_batches b
     where b.id = any (v_batches) and b.tenant_id = v_tenant and b.removed_at is null
     order by b.id limit 1;
    if v_batch is not null then
      v_inv := public.remove_opening_invoice_import(v_batch, 'Zoho Books import undone: ' || v_reason);
      v_inv_n := v_inv_n + coalesce((v_inv->>'removed')::integer, 0);
    else
      select array_agg(s.id) into v_chunk
        from (select s.id from public.subscriptions s
               where s.tenant_id = v_tenant and s.id = any (v_run.created_subscription_ids)
               limit 250) s;
      if v_chunk is not null then
        delete from public.subscriptions where tenant_id = v_tenant and id = any (v_chunk);
        get diagnostics v_n = row_count;
        v_subs := v_subs + v_n;
      else
        select array_agg(c.id) into v_chunk
          from (select c.id from public.customers c
                 where c.tenant_id = v_tenant and c.id = any (v_run.created_customer_ids)
                 limit 250) c;
        if v_chunk is not null then
          -- Their contact persons first (made by this import, linked to nobody else), so the
          -- customer delete does not have to clear contacts.customer_id one by one.
          delete from public.contacts ct
           where ct.tenant_id = v_tenant and ct.id = any (v_run.created_contact_ids)
             and ct.customer_id = any (v_chunk)
             and not exists (select 1 from public.customer_contacts cc
                              where cc.contact_id = ct.id and not (cc.customer_id = any (v_chunk)));
          delete from public.customers where tenant_id = v_tenant and id = any (v_chunk);
          get diagnostics v_n = row_count;
          v_custs := v_custs + v_n;
        else
          v_done := true;
        end if;
      end if;
    end if;
    v_batch := null;
    v_chunk := null;
    exit when v_done or clock_timestamp() - v_t0 > interval '2500 milliseconds';
  end loop;

  v_result := jsonb_build_object('batch_id', p_run_id, 'subscriptions_removed', v_subs, 'customers_removed', v_custs,
                                 'invoices_removed', v_inv_n, 'done', v_done);
  if not v_done then
    update public.zoho_books_import_runs
       set undo_started_at = coalesce(undo_started_at, now()), undo_reason = left(v_reason, 500), updated_at = now(),
           import_tally = v_tally || jsonb_build_object('undo_invoices', v_inv_n, 'undo_subscriptions', v_subs, 'undo_customers', v_custs)
     where id = p_run_id and tenant_id = v_tenant;
    return v_result;
  end if;

  delete from public.contacts ct
   where ct.tenant_id = v_tenant and ct.id = any (v_run.created_contact_ids)
     and not exists (select 1 from public.customer_contacts cc where cc.contact_id = ct.id);

  -- R-1760: a half-finished import is closed too, so a new dry run can start.
  update public.zoho_books_import_runs
     set undone_at = now(), undone_by = auth.uid(), undo_reason = left(v_reason, 500), updated_at = now(),
         undo_started_at = coalesce(undo_started_at, now()),
         imported_at = coalesce(imported_at, now()),
         result = coalesce(result, v_result || jsonb_build_object('partial', true)),
         import_tally = v_tally || jsonb_build_object('undo_invoices', v_inv_n, 'undo_subscriptions', v_subs, 'undo_customers', v_custs),
         import_stage = 'done', import_plan = null
   where id = p_run_id and tenant_id = v_tenant;
  delete from public.zoho_books_import_records where run_id = p_run_id and tenant_id = v_tenant;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_books.import_undone', 'zoho_books_import', p_run_id::text,
          left(format('Undid Zoho Books import: %s customers, %s subscriptions, %s invoices — %s',
                      v_custs, v_subs, v_inv_n, v_reason), 120),
          v_result || jsonb_build_object('reason', v_reason));
  return v_result;
end;
$function$;

comment on function public.zoho_books_import_undo(uuid, text) is
  'R-1753/R-1760: takes back one Zoho Books import — finished or half-finished — (customers, contacts, subscriptions it created + every part''s opening invoices) while nothing has used them. Removes what fits in ~2.5 s per call and returns done=false until all is gone. Owner/accountant.';
revoke all on function public.zoho_books_import_undo(uuid, text) from public;
revoke all on function public.zoho_books_import_undo(uuid, text) from anon;
grant execute on function public.zoho_books_import_undo(uuid, text) to authenticated, service_role;

-- ── 6. R-1753's one-call import must not finish an import begun in parts ─────────────────
-- The server no longer calls zoho_books_import_apply(); this keeps the two from ever doubling
-- one import (apply sets imported_at without moving the cursor to 'done').
create or replace function public.zoho_books_import_runs_parts_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  /* R-1760 */
  if old.import_stage is not null and old.imported_at is null and new.imported_at is not null
     and new.import_stage is distinct from 'done' then
    raise exception 'This import is running in parts. Press Continue import to finish it.' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function public.zoho_books_import_runs_parts_guard() from public;

drop trigger if exists zoho_books_import_runs_parts_guard on public.zoho_books_import_runs;
create trigger zoho_books_import_runs_parts_guard
  before update on public.zoho_books_import_runs
  for each row execute function public.zoho_books_import_runs_parts_guard();
