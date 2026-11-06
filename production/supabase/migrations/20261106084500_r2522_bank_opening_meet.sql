-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bank_transactions' and column_name = 'value_date') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bank_opening_history' and column_name = 'accepted_reason') and exists(select 1 from pg_proc where oid = to_regprocedure('public.set_bank_opening_from_statement(uuid,bigint,date,uuid,boolean,text)') and prosrc like '%R-2522%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_bank_statement(uuid,jsonb,text,text)') and prosrc like '%R-2522%') and to_regprocedure('public.import_bank_statement_with_opening(uuid,jsonb,text,text,bigint,date,boolean,text)') is not null
-- deploy-key: r2522bankopeningmeet
--
-- R-2522 (6 Nov 2026, p1 paisa, G-RECON; follows R-2497): moving a bank account's opening
-- EARLIER from a statement refused a correct statement, and the owner's override kept no reason.
--
-- ══ THE CASE (staging, HDFC 4523, FY 25-26 statement 1 Apr 2025 – 31 Mar 2026) ══
--   Its last line, SUBHVISION NEFT ₹37,170, has txn date 01/04/26 and value date 31/03/26.
--   HDFC counts it inside the 31 Mar 2026 closing ₹9,03,551.93 — the account's opening as of
--   1 Apr 2026 — and the app does not have that line yet (the Apr–Oct statement starts after it).
--   set_bank_opening_from_statement (R-2497, 20261105071119) compared only the lines dated
--   BEFORE the old opening date, so it said −₹37,172 and refused; the owner had to override,
--   and the override has no reason anywhere. The other −₹2 was paise: 3,664 rupee-rounded
--   amounts against the bank's paise balance.
--
-- ══ WHAT CHANGES ══
--   bank_transactions.value_date (new, nullable)   the statement's value date, when it prints one.
--   bank_opening_history.accepted_reason (new)     the owner's reason for "set it anyway".
--   import_bank_statement(uuid,jsonb,text,text)    the R-1623b body as is + value_date stored
--     from the row (no value date → null). Same signature, security, grants.
--   set_bank_opening_from_statement(uuid,bigint,date,uuid,boolean,text) (new overload, p_reason;
--     no defaults, so a 3–5 argument call still resolves to the old signature only):
--     moving EARLIER — the statement's balance where it MEETS the existing data must equal the
--     old opening (±₹1). Counted up to that point:
--       • every line in the account dated from the new date up to the day before the old date
--         (any batch, manual lines too — after the move they are all counted), and
--       • THIS import's lines dated ON or before the old date, by value date where it is earlier
--         (least(txn_date, value_date)) — new to the app, so before the existing data. A line
--         that was already in the account on that date is existing data and is not counted.
--     The figure is the statement's own running balance after those lines (the one line of their
--     last day that no other line of that day continues from), when every line of that day has a
--     balance and the summed figure (new opening + Σ amounts) is within rounding of it
--     (floor(n/2)+1, the account page's roundingAllowance) — else the summed figure, so a
--     missing line still shows. Same / later date: unchanged (R-2497).
--     Accepting a difference (owner only, as before) now needs a reason (5+ characters); it is
--     stored in bank_opening_history.accepted_reason.
--   set_bank_opening_from_statement(uuid,bigint,date,uuid,boolean)  (R-2497 signature) kept as a
--     wrapper → the new one with no reason (so it can no longer accept a difference).
--   import_bank_statement_with_opening(…,boolean,text) (new overload, p_reason) and the R-2497
--     7-argument one kept as a wrapper → no reason.
--   TS preview of the same rule: src/lib/banking/opening-move.ts (openingMoveCheck).
--
-- Test: supabase/tests/r2522_bank_opening_meet.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. Value date on a bank line; reason on an accepted difference ─────────────────────────
alter table public.bank_transactions add column if not exists value_date date;
comment on column public.bank_transactions.value_date is
  'R-2522: the statement''s value date, when it prints one (HDFC "Value Dt"). Used by set_bank_opening_from_statement to place a line at the meeting point; balances still go by txn_date.';

alter table public.bank_opening_history add column if not exists accepted_reason text;
comment on column public.bank_opening_history.accepted_reason is
  'R-2522: the owner''s reason when a statement that does not match the old opening was set anyway.';

-- ── 2. import_bank_statement: R-1623b body + value_date ───────────────────────────────────
create or replace function public.import_bank_statement(
  p_account_id uuid, p_rows jsonb, p_file_name text default null, p_source text default 'csv')
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  /* R-1623 · R-1623b: refusals in English · R-2522: value_date stored */
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
    (tenant_id, bank_account_id, txn_date, value_date, description, debit, credit, balance_after, reference,
     source, category, category_source, category_confidence, import_batch_id)
  select v_tenant, p_account_id, r.txn_date, r.value_date, coalesce(r.description, ''),
         greatest(0, round(coalesce(r.debit, 0)))::integer,
         greatest(0, round(coalesce(r.credit, 0)))::integer,
         round(r.balance_after)::integer, nullif(r.reference, ''),
         'csv_upload', r.category, r.category_source, r.category_confidence, v_batch
    from jsonb_to_recordset(p_rows) as r(
           txn_date date, value_date date, description text, debit numeric, credit numeric, balance_after numeric,
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
  'R-1623: one Import click = one bank_import_batches row + its lines, atomically. Company from current_tenant_id(); owner/manager/accountant. R-2522: stores value_date.';

revoke all on function public.import_bank_statement(uuid, jsonb, text, text) from public;
revoke all on function public.import_bank_statement(uuid, jsonb, text, text) from anon;
grant execute on function public.import_bank_statement(uuid, jsonb, text, text) to authenticated, service_role;

-- ── 3. set_bank_opening_from_statement with the meeting point + reason ─────────────────────
create or replace function public.set_bank_opening_from_statement(
  p_account_id uuid, p_opening bigint, p_date date,
  p_import_batch_id uuid, p_accept_difference boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2497 · R-2522: an earlier move is compared where the statement meets the existing data;
     an accepted difference carries the owner's reason */
  v_tenant  uuid := public.current_tenant_id();
  v_acc     public.bank_accounts;
  v_lock    date;
  v_has_money boolean;
  v_old_total bigint;
  v_new_total bigint;
  v_diff    bigint := null;
  v_on_old  bigint := null;
  v_hist    uuid;
  v_summed  bigint;
  v_n       bigint;
  v_stated  bigint;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_tenant is null then
    raise exception 'The opening balance was not changed: your sign-in is not linked to a company. Sign in again; if it still happens, ask the owner to add you in Team.'
      using errcode = '42501';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'The opening balance was not changed: only an owner, manager or accountant can set it. Ask the owner to import the statement, or to change your role in Team.'
      using errcode = '42501';
  end if;
  if p_opening is null or p_date is null then
    raise exception 'The opening balance was not changed: the amount and the "As of" date are both needed. Pick the date in the import dialog and try again.'
      using errcode = '22023';
  end if;
  select * into v_acc from public.bank_accounts
   where id = p_account_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'The opening balance was not changed: this bank account was not found (or belongs to another company). Open Banking, pick the right account and try again.'
      using errcode = 'P0002';
  end if;

  select books_locked_until into v_lock from public.tenants where id = v_tenant;
  if v_lock is not null and (p_date <= v_lock or v_acc.opening_balance_date <= v_lock) then
    raise exception 'The opening balance was not changed: the books are locked up to % (Month-end close), and moving the opening from % to % changes balances inside the locked period. Unlock the books in Month-end close first, then set the opening again.',
      to_char(v_lock, 'DD Mon YYYY'), to_char(v_acc.opening_balance_date, 'DD Mon YYYY'), to_char(p_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  /* Does the account already carry money the move must keep? Old opening ≠ 0, or a line that
     is COUNTED today (dated on/after the old opening date) and came in before this import
     (this import's own lines are what is being set up). Lines before the old opening are not
     in today's balance, so they are nothing to keep — a fresh account whose earlier statement
     was imported with the tick off can still take the statement's opening. */
  v_has_money := coalesce(v_acc.opening_balance, 0) <> 0
    or exists (select 1 from public.bank_transactions t
                where t.tenant_id = v_tenant and t.bank_account_id = v_acc.id
                  and t.txn_date >= v_acc.opening_balance_date
                  and t.import_batch_id is distinct from p_import_batch_id);

  if v_has_money and v_acc.opening_balance_date is not null then
    if p_date < v_acc.opening_balance_date then
      /* R-2522: the statement's balance where it meets the existing data. Counted: every line
         from the new date up to the day before the old date, and THIS import's lines dated on or
         before the old date (by value date where earlier) — new to the app, so before what the
         app already holds from that date. */
      with c as (
        select t.id, t.txn_date, t.debit, t.credit, t.balance_after
          from public.bank_transactions t
         where t.tenant_id = v_tenant and t.bank_account_id = v_acc.id
           and t.txn_date >= p_date
           and (t.txn_date < v_acc.opening_balance_date
                or (p_import_batch_id is not null and t.import_batch_id = p_import_batch_id
                    and least(t.txn_date, coalesce(t.value_date, t.txn_date)) <= v_acc.opening_balance_date))
      ), agg as (
        select coalesce(sum(c.credit - c.debit), 0)::bigint as s, count(*)::bigint as n, max(c.txn_date) as last_day from c
      ), last_lines as (
        select c.* from c, agg where c.txn_date = agg.last_day
      ), ends as (
        select l.balance_after from last_lines l
         where not exists (select 1 from last_lines o
                            where o.id <> l.id
                              and abs(o.balance_after + o.debit - o.credit - l.balance_after) <= 1)
      )
      select agg.s, agg.n,
             case when agg.n = 0
                    or exists (select 1 from last_lines where balance_after is null)
                    or (select count(*) from ends) <> 1
                  then null else (select e.balance_after from ends e) end
        into v_summed, v_n, v_stated
        from agg;
      v_summed := p_opening + v_summed;
      /* The bank's own balance, unless the summed figure is further from it than rounding of the
         n amounts can explain (then a line is missing — the summed figure shows it). */
      v_on_old := case when v_stated is not null and abs(v_summed - v_stated) <= floor(v_n / 2) + 1
                       then v_stated else v_summed end;
      v_diff := v_on_old - coalesce(v_acc.opening_balance, 0);
    else
      select coalesce(v_acc.opening_balance, 0)
           + coalesce(sum(t.credit - t.debit) filter (where t.txn_date >= v_acc.opening_balance_date), 0),
             p_opening
           + coalesce(sum(t.credit - t.debit) filter (where t.txn_date >= p_date), 0)
        into v_old_total, v_new_total
        from public.bank_transactions t
       where t.tenant_id = v_tenant and t.bank_account_id = v_acc.id;
      v_diff := v_new_total - v_old_total;
    end if;
    if abs(v_diff) > 1 then
      if not coalesce(p_accept_difference, false) then
        if v_on_old is not null then
          raise exception 'The opening balance was not changed: by this statement the balance at the start of % is ₹%, but the account''s opening on that date is ₹% (difference ₹%), so today''s balance would change. A statement line may be missing, or the date may be wrong — check the preview and the account''s Imports list. If the statement is right, the owner can tick "The figures differ — set it anyway".',
            to_char(v_acc.opening_balance_date, 'DD Mon YYYY'), to_char(v_on_old, 'FM99,99,99,99,990'),
            to_char(v_acc.opening_balance, 'FM99,99,99,99,990'), to_char(v_diff, 'FMS99,99,99,99,990')
            using errcode = 'check_violation', hint = 'r2497_opening_mismatch';
        end if;
        raise exception 'The opening balance was not changed: ₹% as of % would change today''s balance by ₹% (the lines already in the account give a different balance on that date). Check the date and the account''s Imports list. If the statement is right, the owner can tick "The figures differ — set it anyway".',
          to_char(p_opening, 'FM99,99,99,99,990'), to_char(p_date, 'DD Mon YYYY'), to_char(v_diff, 'FMS99,99,99,99,990')
          using errcode = 'check_violation', hint = 'r2497_opening_mismatch';
      end if;
      if not public.current_user_is_owner() then
        raise exception 'The opening balance was not changed: the statement does not match the old opening (difference %), and only the owner can accept that. Ask the owner to import this statement.',
          to_char(v_diff, 'FMS99,99,99,99,990')
          using errcode = '42501';
      end if;
      if v_reason is null or length(v_reason) < 5 then
        raise exception 'The opening balance was not changed: setting it anyway (difference %) needs a reason. Write why the figures differ in the opening balance box and import again.',
          to_char(v_diff, 'FMS99,99,99,99,990')
          using errcode = '22023', hint = 'r2522_reason_needed';
      end if;
    end if;
  end if;

  insert into public.bank_opening_history
    (tenant_id, bank_account_id, old_balance, old_date, new_balance, new_date, source,
     balance_on_old_date, difference, accepted_difference, accepted_reason, import_batch_id)
  values (v_tenant, v_acc.id, v_acc.opening_balance, v_acc.opening_balance_date, p_opening, p_date, 'statement',
          v_on_old, v_diff, coalesce(abs(v_diff) > 1, false),
          case when coalesce(abs(v_diff) > 1, false) then left(v_reason, 500) end, p_import_batch_id)
  returning id into v_hist;

  perform set_config('app.r2497_opening_logged', v_acc.id::text, true);
  update public.bank_accounts
     set opening_balance = p_opening::integer, opening_balance_date = p_date
   where id = v_acc.id and tenant_id = v_tenant;
  perform set_config('app.r2497_opening_logged', '', true);

  return jsonb_build_object(
    'history_id', v_hist,
    'old_balance', v_acc.opening_balance, 'old_date', v_acc.opening_balance_date,
    'new_balance', p_opening, 'new_date', p_date,
    'balance_on_old_date', v_on_old, 'difference', v_diff);
end;
$function$;

comment on function public.set_bank_opening_from_statement(uuid, bigint, date, uuid, boolean, text) is
  'R-2497 · R-2522: set a bank account''s opening from a statement; an earlier move is compared where the statement meets the existing data (this import''s lines on/before the old date by value date; the statement''s own balance within rounding); a difference needs the owner and a reason; writes bank_opening_history.';
revoke all on function public.set_bank_opening_from_statement(uuid, bigint, date, uuid, boolean, text) from public, anon;
grant execute on function public.set_bank_opening_from_statement(uuid, bigint, date, uuid, boolean, text) to authenticated;

-- The R-2497 signature: same rule, no reason (so it cannot accept a difference).
create or replace function public.set_bank_opening_from_statement(
  p_account_id uuid, p_opening bigint, p_date date,
  p_import_batch_id uuid default null, p_accept_difference boolean default false)
returns jsonb
language sql
security invoker
set search_path to 'public'
as $function$
  /* R-2497 signature → R-2522 body, no reason */
  select public.set_bank_opening_from_statement(p_account_id, p_opening, p_date, p_import_batch_id, p_accept_difference, null::text);
$function$;
comment on function public.set_bank_opening_from_statement(uuid, bigint, date, uuid, boolean) is
  'R-2497 signature, kept: calls the R-2522 one with no reason (a difference cannot be accepted this way).';
revoke all on function public.set_bank_opening_from_statement(uuid, bigint, date, uuid, boolean) from public, anon;
grant execute on function public.set_bank_opening_from_statement(uuid, bigint, date, uuid, boolean) to authenticated;

-- ── 4. Import + opening in ONE transaction, with the reason ───────────────────────────────
create or replace function public.import_bank_statement_with_opening(
  p_account_id uuid, p_rows jsonb, p_file_name text, p_source text,
  p_opening bigint, p_date date, p_accept_difference boolean, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  /* R-2497 · R-2522 */
  v_import  jsonb;
  v_opening jsonb;
begin
  v_import := public.import_bank_statement(p_account_id, p_rows, p_file_name, coalesce(p_source, 'csv'));
  v_opening := public.set_bank_opening_from_statement(
    p_account_id, p_opening, p_date, nullif(v_import ->> 'batch_id', '')::uuid,
    coalesce(p_accept_difference, false), p_reason);
  return v_import || jsonb_build_object('opening', v_opening);
end;
$function$;
comment on function public.import_bank_statement_with_opening(uuid, jsonb, text, text, bigint, date, boolean, text) is
  'R-2497 · R-2522: import_bank_statement + set_bank_opening_from_statement (with the owner''s reason) in one transaction — a refused opening leaves no lines behind.';
revoke all on function public.import_bank_statement_with_opening(uuid, jsonb, text, text, bigint, date, boolean, text) from public, anon;
grant execute on function public.import_bank_statement_with_opening(uuid, jsonb, text, text, bigint, date, boolean, text) to authenticated;

create or replace function public.import_bank_statement_with_opening(
  p_account_id uuid, p_rows jsonb, p_file_name text, p_source text,
  p_opening bigint, p_date date, p_accept_difference boolean default false)
returns jsonb
language sql
security invoker
set search_path to 'public'
as $function$
  /* R-2497 signature → R-2522 body, no reason */
  select public.import_bank_statement_with_opening(p_account_id, p_rows, p_file_name, p_source, p_opening, p_date, p_accept_difference, null::text);
$function$;
comment on function public.import_bank_statement_with_opening(uuid, jsonb, text, text, bigint, date, boolean) is
  'R-2497 signature, kept: calls the R-2522 one with no reason.';
revoke all on function public.import_bank_statement_with_opening(uuid, jsonb, text, text, bigint, date, boolean) from public, anon;
grant execute on function public.import_bank_statement_with_opening(uuid, jsonb, text, text, bigint, date, boolean) to authenticated;

commit;
