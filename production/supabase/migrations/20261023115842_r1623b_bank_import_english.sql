-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.remove_bank_import(uuid,uuid,text,text,text)') and prosrc like '%R-1623b%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_bank_statement(uuid,jsonb,text,text)') and prosrc like '%R-1623b%')
-- deploy-key: r1623english
-- 20261023115842_r1623b_bank_import_english.sql
--
-- R-1623b (23 Oct 2026 UI rules — the app is English, R-1731): the "Remove import" dialog shows
-- the database's refusal text as-is (bank-imports-section.tsx: catch → setProblem), and the
-- Activity log shows the label remove_bank_import writes. 20261020050000 wrote those in
-- Hinglish, so a refused removal (books lock, wrong role, already removed…) put Hinglish in an
-- English dialog. This re-creates import_bank_statement and remove_bank_import with the SAME
-- logic and English text only; the books-lock refusal still names "Month-end close", which the
-- dialog's "Open Month-end close" link keys on. Signatures, grants and security are unchanged.
-- bank_import_history's one refusal was already English, so it is not touched.
--
-- Guard: src/lib/banking/import-history-sql-english.test.ts (reads the latest definition).

begin;

create or replace function public.import_bank_statement(
  p_account_id uuid, p_rows jsonb, p_file_name text default null, p_source text default 'csv')
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  /* R-1623 · R-1623b: refusals in English */
  v_tenant uuid := public.current_tenant_id();
  v_acc    public.bank_accounts;
  v_batch  uuid;
  v_n      integer;
  v_from   date;
  v_to     date;
  v_source text := lower(btrim(coalesce(p_source, 'csv')));
begin
  if v_tenant is null then
    raise exception 'Statement import needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry — if your account was switched off, ask your workspace owner to turn it on in Team.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can import a bank statement. Ask the owner to import it, or to change your role in Team.'
      using errcode = '42501';
  end if;
  select * into v_acc from public.bank_accounts where id = p_account_id and tenant_id = v_tenant;
  if not found then
    raise exception 'This bank account was not found (or belongs to another company). Open Banking, pick the right account and import again.'
      using errcode = 'P0002';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The import has no lines. Upload the statement file again and click Import once the lines show in the preview.'
      using errcode = '22023';
  end if;
  if v_source not in ('pdf', 'csv', 'xlsx', 'paste', 'image') then v_source := 'csv'; end if;

  insert into public.bank_import_batches (tenant_id, bank_account_id, file_name, source, created_by)
  values (v_tenant, p_account_id, nullif(left(btrim(coalesce(p_file_name, '')), 300), ''), v_source, auth.uid())
  returning id into v_batch;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, balance_after, reference,
     source, category, category_source, category_confidence, import_batch_id)
  select v_tenant, p_account_id, r.txn_date, coalesce(r.description, ''),
         greatest(0, round(coalesce(r.debit, 0)))::integer,
         greatest(0, round(coalesce(r.credit, 0)))::integer,
         round(r.balance_after)::integer, nullif(r.reference, ''),
         'csv_upload', r.category, r.category_source, r.category_confidence, v_batch
    from jsonb_to_recordset(p_rows) as r(
           txn_date date, description text, debit numeric, credit numeric, balance_after numeric,
           reference text, category text, category_source text, category_confidence integer);
  get diagnostics v_n = row_count;

  select min(txn_date), max(txn_date) into v_from, v_to
    from public.bank_transactions where import_batch_id = v_batch;
  update public.bank_import_batches
     set line_count = v_n, txn_from = v_from, txn_to = v_to
   where id = v_batch;

  return jsonb_build_object('batch_id', v_batch, 'inserted', v_n);
end
$function$;

comment on function public.import_bank_statement(uuid, jsonb, text, text) is
  'R-1623: one Import click = one bank_import_batches row + its lines, atomically. Company from current_tenant_id(); owner/manager/accountant.';

revoke all on function public.import_bank_statement(uuid, jsonb, text, text) from public;
revoke all on function public.import_bank_statement(uuid, jsonb, text, text) from anon;
grant execute on function public.import_bank_statement(uuid, jsonb, text, text) to authenticated, service_role;

create or replace function public.remove_bank_import(
  p_account_id uuid, p_batch_id uuid, p_legacy_from text, p_legacy_to text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  /* R-1623 · R-1623b: refusals in English */
  v_tenant  uuid := public.current_tenant_id();
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_batch   public.bank_import_batches;
  v_from    timestamptz;
  v_to      timestamptz;
  v_ids     uuid[];
  v_n       integer;
  v_rec     integer;
  v_recids  text;
  v_lock    date;
  v_inlock  integer;
  v_first   date;
  v_dfrom   date;
  v_dto     date;
  v_bid     uuid;
  v_file    text;
begin
  if v_tenant is null then
    raise exception 'Removing an import needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant can remove an import. Ask the owner to remove it, or to make your role accountant in Team.'
      using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'Enter a reason for removing this import (at least 3 characters) — it is saved in the activity log.'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.bank_accounts a where a.id = p_account_id and a.tenant_id = v_tenant) then
    raise exception 'This bank account was not found (or belongs to another company). Open Banking and pick the right account.'
      using errcode = 'P0002';
  end if;

  if p_batch_id is not null then
    select * into v_batch from public.bank_import_batches
     where id = p_batch_id and tenant_id = v_tenant and bank_account_id = p_account_id
     for update;
    if not found then
      raise exception 'This import was not found. Refresh the page and check the Imports list again.' using errcode = 'P0002';
    end if;
    if v_batch.removed_at is not null then
      raise exception 'This import was already removed on % — nothing is left to do. Refresh the page.',
        to_char(v_batch.removed_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
    end if;
    select array_agg(t.id order by t.txn_date, t.id) into v_ids
      from (select id, txn_date from public.bank_transactions
             where import_batch_id = p_batch_id and tenant_id = v_tenant
             for update) t;
    v_file := v_batch.file_name;
  else
    if p_legacy_from is null or p_legacy_to is null then
      raise exception 'No import was chosen. In the Imports list, click "Remove import" on the import you want to remove.'
        using errcode = '22023';
    end if;
    begin
      v_from := p_legacy_from::timestamptz;
      v_to   := p_legacy_to::timestamptz;
    exception when others then
      raise exception 'The old import''s time could not be read. Refresh the page and try again.' using errcode = '22023';
    end;
    -- The range must be exactly one old import: no old line within 60 s just outside it,
    -- and no 60 s break inside it (bank_import_history's grouping rule).
    if exists (select 1 from public.bank_transactions t
                where t.tenant_id = v_tenant and t.bank_account_id = p_account_id
                  and t.import_batch_id is null and t.source = 'csv_upload'
                  and ((t.created_at < v_from and t.created_at >= v_from - interval '60 seconds')
                    or (t.created_at > v_to   and t.created_at <= v_to   + interval '60 seconds'))) then
      raise exception 'This old import does not match the Imports list (the range cuts through it). Refresh the page and pick it again from the Imports list.'
        using errcode = '22023';
    end if;
    select array_agg(t.id order by t.txn_date, t.id) into v_ids
      from (select id, txn_date from public.bank_transactions
             where tenant_id = v_tenant and bank_account_id = p_account_id
               and import_batch_id is null and source = 'csv_upload'
               and created_at between v_from and v_to
             for update) t;
    if exists (
      select 1 from (
        select t.created_at - lag(t.created_at) over (order by t.created_at, t.id) as gap
          from public.bank_transactions t
         where t.id = any (coalesce(v_ids, '{}'::uuid[]))) x
       where x.gap > interval '60 seconds') then
      raise exception 'This range covers more than one old import. Refresh the page and pick a single import from the Imports list.'
        using errcode = '22023';
    end if;
  end if;

  v_n := coalesce(cardinality(v_ids), 0);
  if v_n = 0 then
    raise exception 'None of this import''s lines are in the account any more — nothing is left to remove. Refresh the page.'
      using errcode = 'P0002';
  end if;

  -- Reconciled / matched, or pointed at by a booking: refuse the whole removal (§24).
  select count(*), string_agg(t.id::text, ',' order by t.txn_date, t.id)
    into v_rec, v_recids
    from public.bank_transactions t
   where t.id = any (v_ids)
     and (t.matched_to_type is not null
       or exists (select 1 from public.expenses e                where e.reconciled_txn_id = t.id)
       or exists (select 1 from public.balance_sheet_items s     where s.bank_txn_id = t.id)
       or exists (select 1 from public.loan_repayments r         where r.bank_txn_id = t.id)
       or exists (select 1 from public.loans_given g             where g.bank_txn_id = t.id)
       or exists (select 1 from public.prepaid_advances p        where p.bank_txn_id = t.id)
       or exists (select 1 from public.project_payments pp       where pp.bank_txn_id = t.id)
       or exists (select 1 from public.statutory_dues_payments d where d.bank_txn_id = t.id)
       or exists (select 1 from public.tax_payments x            where x.bank_txn_id = t.id));
  if v_rec > 0 then
    raise exception '% of this import''s % lines are reconciled — un-reconcile them first. They are linked to a payment, expense or booking; un-reconcile each one on the account page, then click "Remove import" again.',
      v_rec, v_n
      using errcode = 'P0001', detail = 'reconciled_ids=' || left(v_recids, 4000);
  end if;

  -- Books lock (R-1584): a removal would change a filed month.
  select books_locked_until into v_lock from public.tenants where id = v_tenant;
  if v_lock is not null then
    select count(*), min(txn_date) into v_inlock, v_first
      from public.bank_transactions where id = any (v_ids) and txn_date <= v_lock;
    if v_inlock > 0 then
      raise exception '% of this import''s lines (the first dated %) are in closed books — the books are locked up to %. Ask the owner to unlock them in Accounting → Month-end close, then remove the import.',
        v_inlock, to_char(v_first, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY')
        using errcode = 'P0001';
    end if;
  end if;

  select min(txn_date), max(txn_date) into v_dfrom, v_dto
    from public.bank_transactions where id = any (v_ids);

  delete from public.bank_transactions where id = any (v_ids);
  get diagnostics v_n = row_count;

  if p_batch_id is not null then
    update public.bank_import_batches
       set removed_at = now(), removed_by = auth.uid(), remove_reason = left(v_reason, 500), removed_lines = v_n
     where id = p_batch_id;
    v_bid := p_batch_id;
  else
    insert into public.bank_import_batches
      (tenant_id, bank_account_id, file_name, source, line_count, txn_from, txn_to, created_by, created_at,
       removed_at, removed_by, remove_reason, removed_lines)
    values (v_tenant, p_account_id, null, 'legacy', v_n, v_dfrom, v_dto, null, v_from,
            now(), auth.uid(), left(v_reason, 500), v_n)
    returning id into v_bid;
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'bank_import.removed', 'bank_account', p_account_id::text,
          left(format('Import removed: %s lines%s — %s', v_n,
                      case when v_file is not null then ' (' || v_file || ')' else '' end, v_reason), 120),
          jsonb_build_object('batch_id', v_bid, 'lines', v_n, 'file', v_file, 'reason', v_reason,
                             'txn_from', v_dfrom, 'txn_to', v_dto,
                             'legacy_from', p_legacy_from, 'legacy_to', p_legacy_to));

  return jsonb_build_object('removed', v_n, 'batch_id', v_bid);
end
$function$;

comment on function public.remove_bank_import(uuid, uuid, text, text, text) is
  'R-1623: "Remove import" — deletes one import''s lines only when none is reconciled/booked and none is in the books lock. Owner/accountant; company from current_tenant_id(); writes activity_log; the batch row stays, marked removed.';

revoke all on function public.remove_bank_import(uuid, uuid, text, text, text) from public;
revoke all on function public.remove_bank_import(uuid, uuid, text, text, text) from anon;
grant execute on function public.remove_bank_import(uuid, uuid, text, text, text) to authenticated, service_role;

commit;
