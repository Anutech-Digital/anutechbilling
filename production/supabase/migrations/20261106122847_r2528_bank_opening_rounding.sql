-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bank_transactions' and column_name = 'net_paise') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bank_transactions' and column_name = 'balance_after_paise') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_bank_statement(uuid,jsonb,text,text)') and prosrc like '%R-2528%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.r2522_bank_meet_balance(uuid,uuid,date,date,uuid,bigint,boolean)') and prosrc like '%R-2528%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.set_bank_opening_from_statement(uuid,bigint,date,uuid,boolean,text)') and prosrc like '%R-2528%')
-- deploy-key: r2528bankopeningrounding
--
-- R-2528 (6 Nov 2026, p1 paisa, G-RECON) — review follow-ups of R-2522 (rv-r2522; migration
-- 20261106094151_r2522_bank_opening_meet, lib/banking/opening-move.ts).
--
-- ══ 1. A MISSING SMALL LINE WAS TAKEN AS ROUNDING (MEDIUM) ══
--   R-2522 used the bank's own running balance at the meeting point whenever the summed figure
--   (new opening + Σ stored rupee amounts) was within least(floor(n/2)+1, 25) of it, and then
--   checked ±₹1. On 48+ lines a missing ₹17.70 SMS charge — or any line of ₹25 or less — passed
--   with no owner and no reason; only rounding_drift showed it.
--   Why there was drift at all: the import stores WHOLE RUPEES. The parser rounds every amount and
--   balance (statement-parse parseAmount, half away from zero) before anything reaches the
--   database, so the paise are gone; each rounded amount is off by up to ₹0.50 and n of them by up
--   to n/2 — on a 3,665-line year that bound (₹1,833) hides anything, and the ₹25 cap was a guess.
--   Excel's FY 25-26 case (SUBHVISION ₹37,170, value 31/03/26, txn 01/04/26) stored −2 that way:
--   in the fixture the three .50 amounts round UP (−₹1.50 on debits) and ₹1,000.47 rounds down
--   (−₹0.47), the opening ₹20,20,918.96 → ₹20,20,919 (+₹0.04): Σ −₹1.93 → ₹9,03,550 summed against
--   the bank's ₹9,03,551.93 (₹9,03,552) = −2.
--   NOW: the paise travel with the line. The parser keeps them (ParsedRow.amount_paise /
--   balance_paise, only when the printed figure has paise), the app sends them, and the import
--   stores bank_transactions.net_paise (credit − debit, paise) and balance_after_paise — always,
--   for every line of an import (whole-rupee lines: rupees × 100). Paise that do not round to the
--   line's own rupees are not trusted (rupees × 100 is stored instead).
--   The meeting point is compared in PAISE: the bank's own balance is used only when
--   |(new opening × 100 + Σ net_paise) − the bank's balance in paise| ≤ 50 — the one rounding left,
--   the opening's (whole rupees, from the statement's paise). A bank's statement is exact to the
--   paisa, so SUBHVISION differs by 4 paise and matches honestly; a missing ₹17.70 is 1,770 paise
--   and is a difference the owner must accept with a reason, like any other.
--   A counted line whose paise are NOT known (already in the account: an earlier import, a manual
--   line) may be off by ₹0.50 itself — then at most 100 paise (₹1), never more: beyond that the
--   summed figure is used and the difference shows.
-- ══ 2. PREVIEW ≠ SERVER (LOW) ══
--   The rule here is unchanged (a line dated after the old date counts only when its value date
--   is BEFORE the old date; the second reading adds the lines dated ON the old date); the preview
--   (opening-move.ts) also counted a line dated after the old date whose value date EQUALS it — it
--   now follows this rule, and its summed figure adds whole-rupee amounts line by line as stored.
-- ══ 3. p_import_batch_id WAS TRUSTED (LOW) ══
--   set_bank_opening_from_statement now refuses a batch that is not THIS bank account's in THIS
--   company (hint r2528_batch_not_this_account) before anything else uses it.
--
-- WHAT CHANGES
--   bank_transactions.net_paise, .balance_after_paise (new, nullable; null = paise not known).
--   import_bank_statement(uuid,jsonb,text,text)       R-2522 body + the two paise columns.
--   r2522_bank_meet_balance(...)                       same signature/outputs; compared in paise.
--   set_bank_opening_from_statement(…,boolean,text)    R-2522 body + the batch check.
--   Wrappers (5-arg, 7-arg) and import_bank_statement_with_opening: unchanged (they call these).
--   Bodies keep the 'R-1623b' / 'R-2497' / 'R-2522' marks the older deploy-peeks look for.
--
-- Tests: supabase/tests/r2528_bank_opening_rounding.test.sql (A–G; red without this file),
--        supabase/tests/r2522_bank_opening_meet.test.sql (A now sends paise, as the app does).

begin;

-- ── 1. The line's paise ─────────────────────────────────────────────────────────────────────
alter table public.bank_transactions add column if not exists net_paise bigint;
alter table public.bank_transactions add column if not exists balance_after_paise bigint;
comment on column public.bank_transactions.net_paise is
  'R-2528: credit − debit in PAISE as the statement printed it (the debit/credit columns are whole rupees). Set by import_bank_statement for every line it adds; null = not known (manual line, older import). Used only by set_bank_opening_from_statement''s meeting point.';
comment on column public.bank_transactions.balance_after_paise is
  'R-2528: the statement''s running balance after this line in PAISE (balance_after is whole rupees). Set by import_bank_statement; null = not known.';

-- ── 2. import_bank_statement: R-2522 body + paise ──────────────────────────────────────────
create or replace function public.import_bank_statement(
  p_account_id uuid, p_rows jsonb, p_file_name text default null, p_source text default 'csv')
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  /* R-1623 · R-1623b: refusals in English · R-2522: value_date stored · R-2528: the line's paise
     stored (net_paise, balance_after_paise) — sent paise only when they round to the line's own
     rupees, else rupees × 100 */
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
     source, category, category_source, category_confidence, import_batch_id, net_paise, balance_after_paise)
  select v_tenant, p_account_id, x.txn_date, x.value_date, coalesce(x.description, ''),
         x.dr, x.cr, x.bal, nullif(x.reference, ''),
         'csv_upload', x.category, x.category_source, x.category_confidence, v_batch,
         case when x.amount_paise is not null and x.amount_paise >= 0 and x.amount_paise = trunc(x.amount_paise)
                   and round(x.amount_paise / 100.0) = x.dr + x.cr
              then (case when x.cr > 0 then x.amount_paise else -x.amount_paise end)::bigint
              else (x.cr - x.dr)::bigint * 100 end,
         case when x.bal is null then null
              when x.balance_paise is not null and x.balance_paise = trunc(x.balance_paise)
                   and round(x.balance_paise / 100.0) = x.bal
              then x.balance_paise::bigint
              else x.bal::bigint * 100 end
    from (
      select r.*, greatest(0, round(coalesce(r.debit, 0)))::integer as dr,
             greatest(0, round(coalesce(r.credit, 0)))::integer as cr,
             round(r.balance_after)::integer as bal
        from jsonb_to_recordset(p_rows) as r(
               txn_date date, value_date date, description text, debit numeric, credit numeric, balance_after numeric,
               reference text, category text, category_source text, category_confidence integer,
               amount_paise numeric, balance_paise numeric)
    ) x;
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
  'R-1623: one Import click = one bank_import_batches row + its lines, atomically. Company from current_tenant_id(); owner/manager/accountant. R-2522: stores value_date. R-2528: stores each line''s paise (net_paise, balance_after_paise).';

revoke all on function public.import_bank_statement(uuid, jsonb, text, text) from public;
revoke all on function public.import_bank_statement(uuid, jsonb, text, text) from anon;
grant execute on function public.import_bank_statement(uuid, jsonb, text, text) to authenticated, service_role;

-- ── 3. The meeting point, compared in paise (internal helper; same signature) ──────────────
create or replace function public.r2522_bank_meet_balance(
  p_tenant uuid, p_account uuid, p_new_date date, p_old_date date,
  p_batch uuid, p_opening bigint, p_same_day boolean,
  out balance bigint, out drift bigint, out lines_on_old integer)
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  /* R-2522 · R-2528: the bank's balance is used only within the opening's own rounding (50 paise),
     compared in paise; a counted line whose paise are not known allows 100 paise at most */
  v_s bigint; v_sp bigint; v_n bigint; v_last date; v_stated bigint := null; v_left boolean; v_nulls boolean;
  v_exact boolean;
begin
  with c as (
    select t.id, t.txn_date, t.debit, t.credit, t.balance_after,
           /* paise known: a line of THIS import (the import stores them for every line) */
           (p_batch is not null and t.import_batch_id = p_batch and t.net_paise is not null) as exact,
           case when p_batch is not null and t.import_batch_id = p_batch and t.net_paise is not null
                then t.net_paise else (t.credit - t.debit)::bigint * 100 end as net_p,
           case when p_batch is not null and t.import_batch_id = p_batch and t.balance_after_paise is not null
                then t.balance_after_paise else t.balance_after::bigint * 100 end as bal_p
      from public.bank_transactions t
     where t.tenant_id = p_tenant and t.bank_account_id = p_account
       and t.txn_date >= p_new_date
       and (t.txn_date < p_old_date
            or (p_batch is not null and t.import_batch_id = p_batch
                and (least(t.txn_date, coalesce(t.value_date, t.txn_date)) < p_old_date
                     or (p_same_day and t.txn_date = p_old_date))))
  ), agg as (
    select coalesce(sum(c.credit - c.debit), 0)::bigint as s, coalesce(sum(c.net_p), 0)::bigint as sp,
           count(*)::bigint as n, coalesce(bool_and(c.exact), true) as exact,
           max(c.txn_date) as last_day, (count(*) filter (where c.txn_date >= p_old_date))::integer as on_old
      from c
  ), last_lines as (
    select c.* from c, agg where c.txn_date = agg.last_day
  ), ends as (
    select l.bal_p from last_lines l
     where not exists (select 1 from last_lines o
                        where o.id <> l.id
                          and abs(o.bal_p - o.net_p - l.bal_p) <= 100)
  )
  select agg.s, agg.sp, agg.n, agg.last_day, agg.on_old, agg.exact,
         exists (select 1 from last_lines where balance_after is null),
         /* a line of this import on that last day that is NOT counted would be inside its balance */
         (p_batch is not null and agg.last_day >= p_old_date and exists (
            select 1 from public.bank_transactions t
             where t.tenant_id = p_tenant and t.bank_account_id = p_account and t.import_batch_id = p_batch
               and t.txn_date = agg.last_day
               and not exists (select 1 from last_lines l where l.id = t.id))),
         case when (select count(*) from ends) = 1 then (select e.bal_p from ends e)::bigint end
    into v_s, v_sp, v_n, v_last, lines_on_old, v_exact, v_nulls, v_left, v_stated
    from agg;
  v_s := p_opening + v_s;
  v_sp := p_opening * 100 + v_sp;
  if v_n > 0 and not v_nulls and not coalesce(v_left, false) and v_stated is not null
     and abs(v_sp - v_stated) <= case when v_exact then 50 else 100 end then
    balance := round(v_stated / 100.0)::bigint; drift := v_s - balance;
  else
    balance := v_s; drift := 0;
  end if;
end;
$function$;
comment on function public.r2522_bank_meet_balance(uuid, uuid, date, date, uuid, bigint, boolean) is
  'R-2522 · R-2528: internal — one reading of the statement''s balance where it meets the existing data, compared in paise (the bank''s balance only within the opening''s 50-paise rounding; 100 when a counted line''s paise are not known); called only by set_bank_opening_from_statement (SECURITY DEFINER). Same rule as lib/banking/opening-move.ts.';
revoke all on function public.r2522_bank_meet_balance(uuid, uuid, date, date, uuid, bigint, boolean) from public, anon, authenticated;

-- ── 4. set_bank_opening_from_statement: the batch must be this account's ───────────────────
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
     an accepted difference carries the owner's reason · R-2528: the import batch must be this
     account's (this company's), and the meeting point is compared in paise */
  v_tenant  uuid := public.current_tenant_id();
  v_acc     public.bank_accounts;
  v_lock    date;
  v_has_money boolean;
  v_old_total bigint;
  v_new_total bigint;
  v_diff    bigint := null;
  v_on_old  bigint := null;
  v_hist    uuid;
  v_drift   bigint := 0;
  v_alt     bigint;
  v_alt_drift bigint;
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
  /* R-2528: the batch decides which lines are "this import" below — it must be this account's. */
  if p_import_batch_id is not null and not exists (
       select 1 from public.bank_import_batches b
        where b.id = p_import_batch_id and b.tenant_id = v_tenant and b.bank_account_id = v_acc.id) then
    raise exception 'The opening balance was not changed: that statement import does not belong to this bank account. Import the statement on this account and set the opening from that import.'
      using errcode = '22023', hint = 'r2528_batch_not_this_account';
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
      /* R-2522: the statement's balance where it meets the existing data — two readings of THIS
         import's lines dated on/after the old date (value date before it only; or also every line
         ON the old date); the statement matches if either does, else the closer one is reported.
         Same rule as lib/banking/opening-move.ts (openingMoveCheck). */
      select m.balance, m.drift into v_on_old, v_drift
        from public.r2522_bank_meet_balance(v_tenant, v_acc.id, p_date, v_acc.opening_balance_date,
                                            p_import_batch_id, p_opening, false) m;
      select m.balance, m.drift into v_alt, v_alt_drift
        from public.r2522_bank_meet_balance(v_tenant, v_acc.id, p_date, v_acc.opening_balance_date,
                                            p_import_batch_id, p_opening, true) m;
      if abs(v_on_old - coalesce(v_acc.opening_balance, 0)) > 1
         and (abs(v_alt - coalesce(v_acc.opening_balance, 0)) <= 1
              or abs(v_alt - coalesce(v_acc.opening_balance, 0)) < abs(v_on_old - coalesce(v_acc.opening_balance, 0))) then
        v_on_old := v_alt;
        v_drift := v_alt_drift;
      end if;
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
     balance_on_old_date, difference, rounding_drift, accepted_difference, accepted_reason, import_batch_id)
  values (v_tenant, v_acc.id, v_acc.opening_balance, v_acc.opening_balance_date, p_opening, p_date, 'statement',
          v_on_old, v_diff, nullif(v_drift, 0), coalesce(abs(v_diff) > 1, false),
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
  'R-2497 · R-2522 · R-2528: set a bank account''s opening from a statement; an earlier move is compared where the statement meets the existing data (this import''s lines on/before the old date by value date; the statement''s own balance only within the opening''s paise rounding); the import batch must be this account''s; a difference needs the owner and a reason; writes bank_opening_history.';
revoke all on function public.set_bank_opening_from_statement(uuid, bigint, date, uuid, boolean, text) from public, anon;
grant execute on function public.set_bank_opening_from_statement(uuid, bigint, date, uuid, boolean, text) to authenticated;

commit;
