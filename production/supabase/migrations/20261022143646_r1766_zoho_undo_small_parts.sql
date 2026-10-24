-- deploy-peek: exists(select 1 from pg_proc where proname = 'zoho_books_import_undo' and prosrc like '%R-1766%')
-- deploy-key: r1766zohoundosmallparts
--
-- R-1766 — "Undo import" of a Zoho Books import stays well under the 8 s statement timeout.
--
-- Owner, localhost 22 Oct (real import: 1,245 customers / 1,371 subscriptions): every undo call
-- took 8.5–10.6 s and one 15.3 s → "canceling statement due to statement timeout"; it stopped
-- at 126 of 1,376 subscriptions and needed a second press.
--
-- Why (measured here with 1,300 customers + contacts, 1,400 subscriptions with R-1763's Zoho
-- columns, 250 open invoices): R-1760's undo removed 250 rows at a time and looked at the
-- clock only AFTER each 250 — so a call ran to 2.5 s and then one more 250. One 250 part
-- measured 0.33 s on a quiet machine and 1.9 s on a busy one (65% of it is the activity-log
-- line every removed row writes); with the dev server and the app running, the last part
-- pushed the call past 8 s.
--
-- Now: parts start at 50 rows and size themselves on the time the previous part took (aim
-- ~250 ms, 10–250 rows); the call stops once 1.5 s have gone and answers done = false. Worst
-- case = 1.5 s + one small part. Every removed row still writes its activity-log line (the
-- audit trail is unchanged); the refusal checks still run on every call, before anything.
-- The answer also says how many there were in all, so the screen can show progress.
-- From R-1760's definition (20261022113730), the latest; R-1763 did not change it.
-- Test: supabase/tests/zoho_books_import_undo_r1766.test.sql.

create or replace function public.zoho_books_import_undo(p_run_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1753, R-1760, R-1766 */
  v_tenant  uuid := public.current_tenant_id();
  v_size    integer := 50;           -- R-1766: rows per part, sized on the last part's time
  v_p0      timestamptz;
  v_ms      numeric;
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

  -- R-1766: remove in small parts until done or 1.5 s have gone (the next call continues).
  loop
    v_p0 := clock_timestamp();
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
               limit v_size) s;
      if v_chunk is not null then
        delete from public.subscriptions where tenant_id = v_tenant and id = any (v_chunk);
        get diagnostics v_n = row_count;
        v_subs := v_subs + v_n;
      else
        select array_agg(c.id) into v_chunk
          from (select c.id from public.customers c
                 where c.tenant_id = v_tenant and c.id = any (v_run.created_customer_ids)
                 limit v_size) c;
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
    -- R-1766: the next part is sized on this one's time (aim ~250 ms; 10–250 rows), and the
    -- call stops at 1.5 s — so it never runs far past that, however slow a row is today.
    if v_chunk is not null then
      v_ms := extract(epoch from clock_timestamp() - v_p0) * 1000;
      v_size := greatest(10, least(250, (v_size * 250 / greatest(v_ms, 1))::integer));
    end if;
    v_batch := null;
    v_chunk := null;
    exit when v_done or clock_timestamp() - v_t0 > interval '1500 milliseconds';
  end loop;

  v_result := jsonb_build_object('batch_id', p_run_id, 'subscriptions_removed', v_subs, 'customers_removed', v_custs,
                                 'invoices_removed', v_inv_n, 'done', v_done,
                                 /* R-1766: how many in all, for "Undoing… 300 of 1,371 subscriptions" */
                                 'subscriptions_total', coalesce(array_length(v_run.created_subscription_ids, 1), 0),
                                 'customers_total', coalesce(array_length(v_run.created_customer_ids, 1), 0));
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
  'R-1753/R-1760/R-1766: takes back one Zoho Books import — finished or half-finished — (customers, contacts, subscriptions it created + every part''s opening invoices) while nothing has used them. Removes small self-sizing parts for ~1.5 s per call and returns done=false until all is gone. Owner/accountant.';
revoke all on function public.zoho_books_import_undo(uuid, text) from public;
revoke all on function public.zoho_books_import_undo(uuid, text) from anon;
grant execute on function public.zoho_books_import_undo(uuid, text) to authenticated, service_role;
