-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'billed_externally_until') and exists(select 1 from pg_proc where oid = to_regprocedure('public.zoho_books_import_step(uuid,integer)') and prosrc like '%R-1763%') and to_regprocedure('public.subscription_billings_not_billed_elsewhere()') is not null
-- deploy-key: r1763zohobilledinzoho
--
-- R-1763 — a subscription imported from Zoho Books says where it came from, and its current
-- term is never invoiced again here.
--
-- Measured 22 Oct 2026 (local, Excel tenant, real Zoho import after R-1760):
--   - subscriptions.external_ref was null on every imported row — "where did these 4 seats
--     come from?" could not be answered;
--   - the drawer's Billing schedule showed the imported term as "DATE PASSED · scheduled, not
--     invoiced", although Zoho had billed (and been paid for) it;
--   - worse, a monthly / quarterly / half-yearly imported subscription is split-billed, and the
--     daily billing cron (lib/billing/sync-instalments.server.ts) lays the CURRENT term's
--     instalments into subscription_billings and raises a tax invoice for every one whose date
--     has passed — a second invoice for a term Zoho already billed.
--
-- So:
--   1. subscriptions gets external_source ('zoho_books'), external_ref_date (the Zoho invoice
--      date; external_ref, already on the table and unused, holds its number) and
--      billed_externally_until — the last day billed outside this app (inclusive). The import
--      sets it to the imported renewal date, so the whole current term is "Billed in Zoho";
--      the next term (after renewal) is billed here as usual.
--   2. zoho_books_import_step (latest: 20261022113730_r1760) fills them. Nothing else in it
--      changes.
--   3. subscription_billings refuses an instalment (or invoicing one) whose period starts on or
--      before billed_externally_until — the server-side stop behind the cron's own skip.
--
-- Rows imported before this migration have the three columns null (no data repair here —
-- undo + import again fills them).

alter table public.subscriptions
  add column if not exists external_source text,
  add column if not exists external_ref_date date,
  add column if not exists billed_externally_until date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_external_source_check') then
    alter table public.subscriptions add constraint subscriptions_external_source_check
      check (external_source is null or external_source in ('zoho_books'));
  end if;
end $$;

comment on column public.subscriptions.external_source is
  'R-1763: the system this subscription was imported from (zoho_books); null = made here.';
comment on column public.subscriptions.external_ref is
  'R-1763: for an imported subscription, the invoice number in the source system its current term came from (e.g. Zoho INV-000871).';
comment on column public.subscriptions.external_ref_date is
  'R-1763: the date of that source invoice.';
comment on column public.subscriptions.billed_externally_until is
  'R-1763: last day (inclusive) already billed in the source system. Billing periods starting on or before it are never invoiced here (trigger on subscription_billings).';

-- ── 2. The import step stores the Zoho source ────────────────────────────────────────────
create or replace function public.zoho_books_import_step(p_run_id uuid, p_limit integer default 150)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1760, R-1763: the subscription keeps the Zoho invoice its current term came from */
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
          status, domain, outstanding_amount, auto_renew, billing_cycle, term_months,
          external_source, external_ref, external_ref_date, billed_externally_until)
        values (
          v_tenant, v_id, v_cust_name, left(btrim(v_row->>'plan'), 200),
          (case when v_row->>'vendor' in ('google', 'microsoft', 'zoho') then v_row->>'vendor' else 'other' end)::public.vendor,
          (v_row->>'seats')::integer, 0, (v_row->>'mrr')::integer,
          (v_row->>'start_date')::date, (v_row->>'renewal_date')::date,
          'active', v_domain, 0, true,
          (case when v_row->>'billing_cycle' in ('monthly', 'quarterly', 'half_yearly', 'yearly') then v_row->>'billing_cycle' else 'yearly' end)::public.billing_cycle,
          (v_row->>'term_months')::integer,
          'zoho_books', nullif(left(btrim(coalesce(v_row->>'source_invoice', '')), 60), ''),
          case when coalesce(v_row->>'source_invoice_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (v_row->>'source_invoice_date')::date end,
          (v_row->>'renewal_date')::date)
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
  'R-1760/R-1763: imports the next part (≤ p_limit rows, default 150, at most 500) of a begun Zoho Books import and moves the cursor in the same transaction; a Zoho contact already imported is never created again. Each subscription keeps its Zoho invoice number/date and its current term is marked billed in Zoho (billed_externally_until = renewal date). Finishes the import after the last part. Owner/manager/accountant; tenant from current_tenant_id().';
revoke all on function public.zoho_books_import_step(uuid, integer) from public;
revoke all on function public.zoho_books_import_step(uuid, integer) from anon;
grant execute on function public.zoho_books_import_step(uuid, integer) to authenticated, service_role;

-- ── 3. Never lay or invoice an instalment for a period billed in Zoho ─────────────────────
create or replace function public.subscription_billings_not_billed_elsewhere()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1763 */
  v_until  date;
  v_source text;
  v_ref    text;
begin
  if tg_op = 'UPDATE' and not (old.invoice_id is null and new.invoice_id is not null) then
    return new;
  end if;
  select s.billed_externally_until, s.external_source, s.external_ref
    into v_until, v_source, v_ref
    from public.subscriptions s where s.id = new.subscription_id;
  if v_until is not null and new.period_start <= v_until then
    raise exception 'This period (from %) was already billed in % (%). It is not invoiced again here.',
      to_char(new.period_start, 'DD Mon YYYY'),
      case v_source when 'zoho_books' then 'Zoho Books' else 'another system' end,
      coalesce(v_ref, 'no invoice number')
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function public.subscription_billings_not_billed_elsewhere() from public;
revoke all on function public.subscription_billings_not_billed_elsewhere() from anon;

drop trigger if exists subscription_billings_not_billed_elsewhere on public.subscription_billings;
create trigger subscription_billings_not_billed_elsewhere
  before insert or update of invoice_id on public.subscription_billings
  for each row execute function public.subscription_billings_not_billed_elsewhere();
