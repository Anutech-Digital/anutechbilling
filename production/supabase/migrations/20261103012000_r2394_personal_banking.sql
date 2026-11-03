-- deploy-peek: (to_regprocedure('public.personal_bank_reconcile(uuid,text,jsonb)') is not null and to_regprocedure('public.personal_bank_unreconcile(uuid)') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'personal_transactions' and column_name = 'reconciled_at'))
-- deploy-key: r2394personalbanking
-- R-2394 (goal G-PERSONAL, 3 Nov 2026): Private Vault → Banking works like the business
-- Banking — statement import, lines with a running balance, reconcile each line, a real
-- (computed) balance and a statement check. Accounts are still shown as ASSETS.
--
-- Pardeep (3 Nov): "isko bhi poora vaisa hi banao jaise proprietorship me banking handle hoti
-- hai par bank ko asset ke roop me hi show karo".
--
-- What this adds
--   * personal_accounts.opening_as_of — the day the opening balance is "as of".
--   * personal_transactions:
--       reconciled_at — when an IMPORTED statement line was matched (null = unmatched). Manual
--                       entries are the owner's own book entries and need no matching.
--       line_no       — the line's position in its statement file, so lines of one date keep
--                       the bank's order (the running balance and the statement check need it).
--       pair_tx_id    — the other leg of a transfer / card payment / ATM cash between two of
--                       the person's own accounts (owner-safe composite FK, set null on delete).
--       auto_pair     — the other leg was CREATED by reconcile (undo removes it again).
--       owe_hold_id   — the R-2386 "money I owe / hold" entry a byana line belongs to.
--   * personal_import_commit(jsonb) — same as GP-12b, plus line_no = the line's position.
--   * personal_bank_reconcile(tx, action, payload) — ONE atomic call (§17b) per line, with the
--     vault meanings only: expense, income (R-2387 source), drawing (from company),
--     card_payment, atm_cash, transfer (pairs the other account's line or creates it),
--     loan (R-2388 personal_loan_record_payment with the principal / interest split),
--     owe_hold (R-2386 byana / held money), match (an entry already typed on Loans / Income &
--     Expenses — the bank line merges into it, so the money is never counted twice).
--     Optional rule "always put X under Y" (personal_category_rules) — other unmatched lines
--     with X get Y as their suggestion.
--   * personal_bank_unreconcile(tx) — undo a match (a loan match is undone on the Loans page).
--
-- Balance (unchanged view personal_account_balances): opening_balance + money in − money out.
-- The old hand-typed personal_accounts.balance is no longer the balance anywhere on screen.
-- DATA STEP (card part 3): an account whose opening_balance is 0 and that has NO transactions
-- gets opening_balance = its old typed balance, as of today (IST) — so nothing on screen
-- changes for those accounts. Accounts that already have transactions are NOT touched (which
-- opening is right for them is the owner's call); the migration prints how many there are.
--
-- The privacy rule is unchanged (20260819170000_owner_personal_vault.sql):
--     owner_user_id = auth.uid()  AND  tenant_id = current_tenant_id()
-- Both functions are SECURITY INVOKER: the caller's own RLS decides which rows exist, and
-- every lookup also says owner_user_id = auth.uid(). Date defaults use public.ist_today().

begin;

-- ─── 1. columns ────────────────────────────────────────────────────────────
alter table public.personal_accounts
  add column if not exists opening_as_of date;

comment on column public.personal_accounts.opening_as_of is
  'R-2394: the day opening_balance is as of. The account balance = opening_balance + money in − money out (personal_account_balances).';

alter table public.personal_transactions
  add column if not exists reconciled_at timestamptz,
  add column if not exists line_no       integer,
  add column if not exists pair_tx_id    uuid,
  add column if not exists auto_pair     boolean not null default false,
  add column if not exists owe_hold_id   uuid;

comment on column public.personal_transactions.reconciled_at is
  'R-2394: when an imported statement line was matched to its meaning (null = unmatched). Manual entries need no matching.';
comment on column public.personal_transactions.line_no is
  'R-2394: position of the line in its statement file (1 = first) — keeps the bank''s order within one date.';
comment on column public.personal_transactions.pair_tx_id is
  'R-2394: the other leg of a transfer / card payment / ATM cash between two of the person''s own accounts.';
comment on column public.personal_transactions.auto_pair is
  'R-2394: this row was created by reconcile as the other leg of a line; undoing the match deletes it.';
comment on column public.personal_transactions.owe_hold_id is
  'R-2394: the R-2386 personal_owe_hold entry (byana / held money) this bank line belongs to.';

-- Owner-safe composite FKs (a service-role job runs without RLS, so the database itself
-- refuses "my line paired with your line").
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_id_owner_key') then
    alter table public.personal_transactions
      add constraint personal_transactions_id_owner_key unique (id, owner_user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_pair_owner_fkey') then
    alter table public.personal_transactions
      add constraint personal_transactions_pair_owner_fkey
      foreign key (pair_tx_id, owner_user_id)
      references public.personal_transactions (id, owner_user_id)
      on delete set null (pair_tx_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'personal_owe_hold_id_owner_key') then
    alter table public.personal_owe_hold
      add constraint personal_owe_hold_id_owner_key unique (id, owner_user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_owe_hold_owner_fkey') then
    alter table public.personal_transactions
      add constraint personal_transactions_owe_hold_owner_fkey
      foreign key (owe_hold_id, owner_user_id)
      references public.personal_owe_hold (id, owner_user_id)
      on delete set null (owe_hold_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_line_no_check') then
    alter table public.personal_transactions
      add constraint personal_transactions_line_no_check check (line_no is null or line_no > 0);
  end if;
end $$;

create index if not exists personal_transactions_unmatched_idx
  on public.personal_transactions (account_id, occurred_on)
  where source = 'import' and reconciled_at is null;

-- ─── 2. data step: typed balance → opening balance (only where nothing else depends on it)
do $$
declare n_moved integer; n_left integer;
begin
  update public.personal_accounts a
     set opening_balance = a.balance,
         opening_as_of   = public.ist_today(),
         updated_at      = now()
   where a.opening_balance = 0
     and a.balance <> 0
     and not exists (select 1 from public.personal_transactions t where t.account_id = a.id);
  get diagnostics n_moved = row_count;

  select count(*) into n_left
    from public.personal_accounts a
   where a.opening_balance = 0 and a.balance <> 0
     and exists (select 1 from public.personal_transactions t where t.account_id = a.id);

  raise notice 'R-2394: % account(s) got opening_balance = typed balance as of today; % account(s) with entries left as they were (owner sets the opening on the account page).', n_moved, n_left;
end $$;

-- ─── 3. personal_import_commit: + line_no (body otherwise GP-12b, 20261030074413) ──
create or replace function public.personal_import_commit(batch jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_tenant   uuid;
  v_account  uuid;
  v_rows     jsonb := batch -> 'rows';
  v_n        integer;
  v_bad      record;
  v_batch_id uuid;
  v_inserted integer;
begin
  if v_uid is null then
    raise exception 'You are not signed in — please sign in again.' using errcode = '42501';
  end if;
  v_tenant := current_tenant_id();
  if v_tenant is null then
    raise exception 'Your workspace is still loading — try again.' using errcode = '42501';
  end if;

  if v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
    raise exception 'The statement has no lines to import.' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(v_rows);
  if v_n > 5000 then
    raise exception 'A statement can have at most 5,000 lines (this one has %). Split it by month.', v_n
      using errcode = '22023';
  end if;

  begin
    v_account := nullif(batch ->> 'account_id', '')::uuid;
  exception when invalid_text_representation then
    v_account := null;
  end;
  if v_account is null
     or not exists (select 1 from public.personal_accounts where id = v_account and owner_user_id = v_uid) then
    raise exception 'Pick one of your accounts for this statement.' using errcode = '42501';
  end if;

  select ord, r into v_bad
    from jsonb_array_elements(v_rows) with ordinality as e(r, ord)
   where coalesce(btrim(r ->> 'dedupe_hash'), '') = ''
      or case when coalesce(r ->> 'amount', '') ~ '^[0-9]{1,15}$'
              then (r ->> 'amount')::bigint <= 0
              else true end
      or coalesce(r ->> 'occurred_on', '') !~ '^\d{4}-\d{2}-\d{2}$'
      or coalesce(r ->> 'kind', '') = ''
   order by ord
   limit 1;
  if found then
    raise exception 'Line % of the statement cannot be imported: it needs a date (YYYY-MM-DD), a kind, a whole-rupee amount above 0 and a dedupe key.', v_bad.ord
      using errcode = '22023';
  end if;

  insert into public.personal_import_batches
    (tenant_id, owner_user_id, account_id, file_name, file_kind, statement_from, statement_to, row_count)
  values
    (v_tenant, v_uid, v_account,
     nullif(btrim(batch ->> 'file_name'), ''),
     nullif(batch ->> 'file_kind', ''),
     nullif(batch ->> 'statement_from', '')::date,
     nullif(batch ->> 'statement_to', '')::date,
     v_n)
  returning id into v_batch_id;

  insert into public.personal_transactions
    (tenant_id, owner_user_id, account_id, kind, amount, occurred_on, category, note,
     source, import_batch_id, reference, raw_description, balance_after, dedupe_hash, line_no)
  select v_tenant, v_uid, v_account,
         r ->> 'kind',
         (r ->> 'amount')::bigint,
         (r ->> 'occurred_on')::date,
         nullif(btrim(r ->> 'category'), ''),
         nullif(btrim(r ->> 'note'), ''),
         'import', v_batch_id,
         nullif(btrim(r ->> 'reference'), ''),
         nullif(r ->> 'raw_description', ''),
         nullif(r ->> 'balance_after', '')::bigint,
         btrim(r ->> 'dedupe_hash'),
         ord::integer
    from jsonb_array_elements(v_rows) with ordinality as e(r, ord)
   order by ord
  on conflict (owner_user_id, account_id, dedupe_hash) where dedupe_hash is not null do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    delete from public.personal_import_batches where id = v_batch_id;
    v_batch_id := null;
  else
    update public.personal_import_batches
       set inserted_count = v_inserted, skipped_count = v_n - v_inserted
     where id = v_batch_id;
  end if;

  return jsonb_build_object('batch_id', v_batch_id, 'inserted', v_inserted, 'skipped', v_n - v_inserted, 'rows', v_n);
end;
$$;

comment on function public.personal_import_commit(jsonb) is
  'R-2128 + R-2394: save one bank/card statement (batch row + lines, line_no = position in the file) atomically for the signed-in person; lines whose dedupe_hash is already in that account are skipped. SECURITY INVOKER — the caller''s owner RLS applies. Returns {batch_id (null when nothing was new), inserted, skipped, rows}.';

revoke all on function public.personal_import_commit(jsonb) from public, anon;
grant execute on function public.personal_import_commit(jsonb) to authenticated, service_role;

-- ─── 4. personal_bank_reconcile ────────────────────────────────────────────
-- p_action: expense | income | drawing | card_payment | atm_cash | transfer | loan | owe_hold | match
-- p (jsonb), by action:
--   expense   {category, party?, rule_text?}
--   income    {income_source, category?, party?, rule_text?}
--   drawing   {party?}
--   card_payment / atm_cash {other_account_id?}   (creates the other leg on that account)
--   transfer  {other_account_id, pair_tx_id?}      (pairs that line, else creates it)
--   loan      {loan_id, pay_kind?, interest?}      (principal = amount − interest)
--   owe_hold  {owe_hold_id?} or {hold_kind, party} (money in: a new entry may be created)
--   match     {match_tx_id}                        (an entry typed on another page)
-- Returns {tx_id (the row that now carries the bank line), action, pair_tx_id, suggested}.
create or replace function public.personal_bank_reconcile(p_tx_id uuid, p_action text, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  t          public.personal_transactions%rowtype;
  v_acc      public.personal_accounts%rowtype;
  v_other    public.personal_accounts%rowtype;
  m          public.personal_transactions%rowtype;
  v_loan     public.personal_loans%rowtype;
  v_dir      integer;
  v_mdir     integer;
  v_kind     text;
  v_cat      text;
  v_src      text;
  v_party    text := nullif(left(btrim(coalesce(p ->> 'party', '')), 120), '');
  v_rule     text := nullif(btrim(coalesce(p ->> 'rule_text', '')), '');
  v_pair     uuid;
  v_hold     uuid;
  v_result   uuid;
  v_suggest  integer := 0;
  v_pay      jsonb;
  v_pay_kind text;
  v_int      bigint;
  v_paid     bigint;
  v_out      bigint;
  v_ptx      uuid;
  v_itx      uuid;
begin
  if v_uid is null then
    raise exception 'You are not signed in — please sign in again.' using errcode = '42501';
  end if;

  select * into t from public.personal_transactions
   where id = p_tx_id and owner_user_id = v_uid for update;
  if not found then
    raise exception 'Statement line not found.' using errcode = 'P0002';
  end if;
  if t.source <> 'import' then
    raise exception 'Only an imported statement line is matched here — this entry was typed by you.' using errcode = '22023';
  end if;
  if t.reconciled_at is not null then
    raise exception 'This line is already matched. Press Undo first to change it.' using errcode = '22023';
  end if;
  select * into v_acc from public.personal_accounts where id = t.account_id and owner_user_id = v_uid;
  if not found then
    raise exception 'This line is not on one of your accounts.' using errcode = '22023';
  end if;

  -- +1 = money into this account, −1 = money out (same rule as personal_account_balances).
  v_dir := case
    when t.kind in ('drawing', 'dividend', 'salary', 'interest', 'other_income', 'transfer_in', 'refund') then 1
    when t.kind = 'card_payment' and v_acc.kind = 'credit_card' then 1
    else -1 end;

  -- The other account (transfer / card payment / ATM cash).
  if p_action in ('transfer', 'card_payment', 'atm_cash') and nullif(p ->> 'other_account_id', '') is not null then
    select * into v_other from public.personal_accounts
     where id = (p ->> 'other_account_id')::uuid and owner_user_id = v_uid;
    if not found then
      raise exception 'Pick one of your accounts.' using errcode = '22023';
    end if;
    if v_other.id = v_acc.id then
      raise exception 'Pick a different account — money cannot move into the same account.' using errcode = '22023';
    end if;
  end if;

  if p_action = 'expense' then
    if v_dir <> -1 then raise exception 'Money came in on this line — an expense is money going out.' using errcode = '22023'; end if;
    v_cat := nullif(left(btrim(coalesce(p ->> 'category', '')), 60), '');
    if v_cat is null then raise exception 'Pick a category.' using errcode = '22023'; end if;
    update public.personal_transactions
       set kind = 'expense', category = v_cat, income_source = null, party = coalesce(v_party, party),
           reconciled_at = now(), updated_at = now()
     where id = t.id;
    v_result := t.id;

  elsif p_action = 'income' then
    if v_dir <> 1 then raise exception 'Money went out on this line — income is money coming in.' using errcode = '22023'; end if;
    v_src := p ->> 'income_source';
    if v_src is null or v_src not in ('salary', 'rent', 'interest', 'dividend', 'business', 'agriculture',
                                      'capital_gains', 'gift', 'refund', 'other') then
      raise exception 'Pick where the money came from.' using errcode = '22023';
    end if;
    v_kind := case v_src when 'salary' then 'salary' when 'interest' then 'interest'
                         when 'dividend' then 'dividend' when 'refund' then 'refund' else 'other_income' end;
    v_cat := nullif(left(btrim(coalesce(p ->> 'category', '')), 60), '');
    update public.personal_transactions
       set kind = v_kind, income_source = v_src, category = v_cat, party = coalesce(v_party, party),
           reconciled_at = now(), updated_at = now()
     where id = t.id;
    v_result := t.id;

  elsif p_action = 'drawing' then
    if v_dir <> 1 then raise exception 'A drawing from the company is money coming in.' using errcode = '22023'; end if;
    update public.personal_transactions
       set kind = 'drawing', category = 'Drawing from company', income_source = null,
           party = coalesce(v_party, party), reconciled_at = now(), updated_at = now()
     where id = t.id;
    v_result := t.id;

  elsif p_action = 'card_payment' then
    if not ((v_acc.kind <> 'credit_card' and v_dir = -1) or (v_acc.kind = 'credit_card' and v_dir = 1)) then
      raise exception 'A card payment is money going out of a bank account, or a payment received on a credit card.' using errcode = '22023';
    end if;
    if v_other.id is not null and (v_other.kind = 'credit_card') = (v_acc.kind = 'credit_card') then
      raise exception 'The other side of a card payment must be %.',
        case when v_acc.kind = 'credit_card' then 'a bank account' else 'a credit card' end using errcode = '22023';
    end if;
    update public.personal_transactions
       set kind = 'card_payment', category = 'Card payment', income_source = null,
           reconciled_at = now(), updated_at = now()
     where id = t.id;
    if v_other.id is not null then
      insert into public.personal_transactions
        (tenant_id, owner_user_id, account_id, kind, category, amount, occurred_on, note,
         pair_tx_id, auto_pair, reconciled_at)
      values (t.tenant_id, v_uid, v_other.id, 'card_payment', 'Card payment', t.amount, t.occurred_on,
              left('Card payment · ' || v_acc.label, 500), t.id, true, now())
      returning id into v_pair;
      update public.personal_transactions set pair_tx_id = v_pair where id = t.id;
    end if;
    v_result := t.id;

  elsif p_action = 'atm_cash' then
    if v_dir <> -1 then raise exception 'ATM cash is money going out of this account.' using errcode = '22023'; end if;
    if v_other.id is not null and v_other.kind = 'credit_card' then
      raise exception 'Cash goes into a cash or wallet account, not a credit card.' using errcode = '22023';
    end if;
    update public.personal_transactions
       set kind = 'atm_cash', category = 'ATM cash', income_source = null,
           reconciled_at = now(), updated_at = now()
     where id = t.id;
    if v_other.id is not null then
      insert into public.personal_transactions
        (tenant_id, owner_user_id, account_id, kind, category, amount, occurred_on, note,
         pair_tx_id, auto_pair, reconciled_at)
      values (t.tenant_id, v_uid, v_other.id, 'transfer_in', 'ATM cash', t.amount, t.occurred_on,
              left('ATM cash from ' || v_acc.label, 500), t.id, true, now())
      returning id into v_pair;
      update public.personal_transactions set pair_tx_id = v_pair where id = t.id;
    end if;
    v_result := t.id;

  elsif p_action = 'transfer' then
    if v_other.id is null then raise exception 'Pick the other account.' using errcode = '22023'; end if;
    if v_acc.kind = 'credit_card' or v_other.kind = 'credit_card' then
      raise exception 'Money to or from a credit card is a "Card payment".' using errcode = '22023';
    end if;
    v_kind := case when v_dir = 1 then 'transfer_in' else 'transfer_out' end;

    if nullif(p ->> 'pair_tx_id', '') is not null then
      select * into m from public.personal_transactions
       where id = (p ->> 'pair_tx_id')::uuid and owner_user_id = v_uid for update;
      if not found or m.account_id is distinct from v_other.id then
        raise exception 'That line is not on %.', v_other.label using errcode = '22023';
      end if;
      v_mdir := case when m.kind in ('drawing', 'dividend', 'salary', 'interest', 'other_income', 'transfer_in', 'refund') then 1 else -1 end;
      if m.amount <> t.amount or v_mdir <> -v_dir then
        raise exception 'The other line must be the same amount going the other way.' using errcode = '22023';
      end if;
      if m.pair_tx_id is not null or (m.source = 'import' and m.reconciled_at is not null) then
        raise exception 'That line is already matched.' using errcode = '22023';
      end if;
      update public.personal_transactions
         set kind = case when v_dir = 1 then 'transfer_out' else 'transfer_in' end,
             category = 'Transfer', income_source = null, pair_tx_id = t.id,
             reconciled_at = now(), updated_at = now()
       where id = m.id;
      v_pair := m.id;
    else
      insert into public.personal_transactions
        (tenant_id, owner_user_id, account_id, kind, category, amount, occurred_on, note,
         pair_tx_id, auto_pair, reconciled_at)
      values (t.tenant_id, v_uid, v_other.id,
              case when v_dir = 1 then 'transfer_out' else 'transfer_in' end,
              'Transfer', t.amount, t.occurred_on,
              left(case when v_dir = 1 then 'Transfer to ' else 'Transfer from ' end || v_acc.label, 500),
              t.id, true, now())
      returning id into v_pair;
    end if;
    update public.personal_transactions
       set kind = v_kind, category = 'Transfer', income_source = null, pair_tx_id = v_pair,
           reconciled_at = now(), updated_at = now()
     where id = t.id;
    v_result := t.id;

  elsif p_action = 'loan' then
    select * into v_loan from public.personal_loans
     where id = nullif(p ->> 'loan_id', '')::uuid and owner_user_id = v_uid;
    if not found then raise exception 'Pick one of your loans.' using errcode = '22023'; end if;
    if v_loan.direction = 'taken' and v_dir <> -1 then
      raise exception 'Money came in on this line — an EMI on a loan you took is money going out.' using errcode = '22023';
    end if;
    if v_loan.direction = 'given' and v_dir <> 1 then
      raise exception 'Money went out on this line — a repayment of a loan you gave is money coming in.' using errcode = '22023';
    end if;
    v_pay_kind := coalesce(nullif(p ->> 'pay_kind', ''), case when v_loan.direction = 'taken' then 'emi' else 'repayment' end);

    if nullif(p ->> 'interest', '') is not null then
      if (p ->> 'interest') !~ '^[0-9]{1,15}$' then
        raise exception 'Interest must be a whole amount in rupees.' using errcode = '22023';
      end if;
      v_int := (p ->> 'interest')::bigint;
    elsif v_pay_kind = 'interest' then
      v_int := t.amount;
    elsif v_pay_kind = 'emi' then
      -- the scheduled reducing-balance interest (same maths as personal_loan_record_payment)
      select coalesce(sum(principal_part), 0) into v_paid from public.personal_loan_payments where loan_id = v_loan.id;
      v_out := greatest(v_loan.principal - v_paid, 0);
      v_int := least(round(v_out * coalesce(v_loan.annual_rate, 0) / 1200.0)::bigint, t.amount);
    else
      v_int := 0;
    end if;
    if v_int > t.amount then
      raise exception 'Interest ₹% is more than the line amount ₹%.', v_int, t.amount using errcode = '22023';
    end if;

    v_pay := public.personal_loan_record_payment(v_loan.id, v_pay_kind, t.occurred_on,
                                                 t.amount - v_int, v_int, t.account_id,
                                                 nullif(left(btrim(coalesce(p ->> 'note', '')), 400), ''));
    select principal_tx_id, interest_tx_id into v_ptx, v_itx
      from public.personal_loan_payments where id = (v_pay ->> 'payment_id')::uuid;
    v_result := coalesce(v_ptx, v_itx);

    -- The bank line now lives in the loan's ledger rows: the statement identity moves onto
    -- one of them and the imported row goes, so the money is counted once and a re-import
    -- of the same statement still skips the line.
    delete from public.personal_transactions where id = t.id;
    update public.personal_transactions
       set source = 'import', import_batch_id = t.import_batch_id, reference = t.reference,
           raw_description = t.raw_description, balance_after = t.balance_after,
           dedupe_hash = t.dedupe_hash, line_no = t.line_no, reconciled_at = now(), updated_at = now()
     where id = v_result;
    if v_ptx is not null and v_itx is not null then
      update public.personal_transactions
         set reconciled_at = now(), line_no = t.line_no, updated_at = now()
       where id = v_itx;
    end if;

  elsif p_action = 'owe_hold' then
    if nullif(p ->> 'owe_hold_id', '') is not null then
      select id into v_hold from public.personal_owe_hold
       where id = (p ->> 'owe_hold_id')::uuid and owner_user_id = v_uid;
      if v_hold is null then raise exception 'Pick one of your owe / hold entries.' using errcode = '22023'; end if;
    elsif v_dir = 1 then
      if coalesce(p ->> 'hold_kind', '') not in ('advance_received', 'held_for_other') or v_party is null then
        raise exception 'Say whose money it is (an advance received, or money held for someone) and their name.' using errcode = '22023';
      end if;
      insert into public.personal_owe_hold
        (tenant_id, owner_user_id, kind, party, occurred_on, amount, account_id, note)
      values (t.tenant_id, v_uid, p ->> 'hold_kind', v_party, t.occurred_on, t.amount, t.account_id,
              left('From bank line · ' || coalesce(t.raw_description, ''), 500))
      returning id into v_hold;
    else
      raise exception 'Pick the owe / hold entry this payment settles.' using errcode = '22023';
    end if;
    update public.personal_transactions
       set kind = case when v_dir = 1 then 'transfer_in' else 'transfer_out' end,
           category = 'Byana / held money', income_source = null, owe_hold_id = v_hold,
           party = coalesce(v_party, party), reconciled_at = now(), updated_at = now()
     where id = t.id;
    v_result := t.id;

  elsif p_action = 'match' then
    select * into m from public.personal_transactions
     where id = nullif(p ->> 'match_tx_id', '')::uuid and owner_user_id = v_uid and id <> t.id for update;
    if not found then raise exception 'Entry not found.' using errcode = 'P0002'; end if;
    if m.source <> 'manual' or m.dedupe_hash is not null then
      raise exception 'Only an entry you typed can be matched to a statement line.' using errcode = '22023';
    end if;
    if m.account_id is not null and m.account_id <> t.account_id then
      raise exception 'That entry is on another account.' using errcode = '22023';
    end if;
    v_mdir := case
      when m.kind in ('drawing', 'dividend', 'salary', 'interest', 'other_income', 'transfer_in', 'refund') then 1
      when m.kind = 'card_payment' and v_acc.kind = 'credit_card' then 1
      else -1 end;
    if m.amount <> t.amount or v_mdir <> v_dir then
      raise exception 'The entry must be the same amount, going the same way.' using errcode = '22023';
    end if;
    delete from public.personal_transactions where id = t.id;
    update public.personal_transactions
       set account_id = t.account_id, source = 'import', import_batch_id = t.import_batch_id,
           reference = t.reference, raw_description = t.raw_description,
           balance_after = t.balance_after, dedupe_hash = t.dedupe_hash, line_no = t.line_no,
           reconciled_at = now(), updated_at = now()
     where id = m.id;
    v_result := m.id;

  else
    raise exception 'Unknown match type %.', coalesce(p_action, 'null') using errcode = '22023';
  end if;

  -- "Always put X under Y": save the rule, and suggest Y on the other unmatched lines with X.
  if v_rule is not null and p_action in ('expense', 'income') then
    if length(v_rule) < 2 or length(v_rule) > 100 then
      raise exception 'The rule text must be 2 to 100 characters.' using errcode = '22023';
    end if;
    v_cat := coalesce(v_cat, (select label from (values
      ('salary', 'Salary'), ('rent', 'Rent Received'), ('interest', 'Interest'), ('dividend', 'Dividend'),
      ('business', 'Business / Freelance'), ('refund', 'Refund')) s(id, label) where id = v_src), 'Other Income');
    insert into public.personal_category_rules (tenant_id, owner_user_id, match_text, category)
    values (t.tenant_id, v_uid, v_rule, v_cat)
    on conflict (owner_user_id, lower(btrim(match_text)))
    do update set category = excluded.category, updated_at = now();

    update public.personal_transactions x
       set category = v_cat, updated_at = now()
     where x.owner_user_id = v_uid
       and x.source = 'import' and x.reconciled_at is null
       and x.id <> t.id
       and strpos(upper(coalesce(x.raw_description, '')), upper(v_rule)) > 0
       and ((p_action = 'expense' and x.kind = 'expense')
         or (p_action = 'income' and x.kind in ('salary', 'interest', 'dividend', 'other_income', 'refund')));
    get diagnostics v_suggest = row_count;
  end if;

  return jsonb_build_object('tx_id', v_result, 'action', p_action, 'pair_tx_id', v_pair, 'suggested', v_suggest);
end;
$$;

comment on function public.personal_bank_reconcile(uuid, text, jsonb) is
  'R-2394: match one imported personal statement line to its meaning in one transaction — expense, income (source), drawing, card_payment / atm_cash / transfer (pairs or creates the other account''s leg), loan (personal_loan_record_payment; the line merges into the loan''s ledger rows), owe_hold (byana / held money), match (merges into an entry typed elsewhere). Optional rule_text saves "always put X under Y". SECURITY INVOKER (owner RLS).';

revoke all on function public.personal_bank_reconcile(uuid, text, jsonb) from public, anon;
grant execute on function public.personal_bank_reconcile(uuid, text, jsonb) to authenticated, service_role;

-- ─── 5. personal_bank_unreconcile ──────────────────────────────────────────
create or replace function public.personal_bank_unreconcile(p_tx_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  t     public.personal_transactions%rowtype;
  m     public.personal_transactions%rowtype;
  v_removed boolean := false;
begin
  if v_uid is null then
    raise exception 'You are not signed in — please sign in again.' using errcode = '42501';
  end if;
  select * into t from public.personal_transactions
   where id = p_tx_id and owner_user_id = v_uid for update;
  if not found then raise exception 'Statement line not found.' using errcode = 'P0002'; end if;
  if t.source <> 'import' or t.reconciled_at is null then
    raise exception 'This line is not matched.' using errcode = '22023';
  end if;
  if exists (select 1 from public.personal_loan_payments
              where owner_user_id = v_uid and (principal_tx_id = t.id or interest_tx_id = t.id)) then
    raise exception 'This line is a loan payment — undo it on the Loans page, then import the statement again to get the line back.'
      using errcode = '22023';
  end if;

  if t.pair_tx_id is not null then
    select * into m from public.personal_transactions where id = t.pair_tx_id and owner_user_id = v_uid for update;
    if found then
      if m.auto_pair then
        update public.personal_transactions set pair_tx_id = null where id = t.id;
        delete from public.personal_transactions where id = m.id;
        v_removed := true;
      else
        update public.personal_transactions
           set pair_tx_id = null,
               reconciled_at = case when source = 'import' then null else reconciled_at end,
               updated_at = now()
         where id = m.id;
      end if;
    end if;
  end if;

  update public.personal_transactions
     set reconciled_at = null, pair_tx_id = null, owe_hold_id = null, updated_at = now()
   where id = t.id;

  return jsonb_build_object('tx_id', t.id, 'removed_pair', v_removed);
end;
$$;

comment on function public.personal_bank_unreconcile(uuid) is
  'R-2394: undo the match of an imported personal statement line (the other leg reconcile created is removed; a loan payment is undone on the Loans page). SECURITY INVOKER (owner RLS).';

revoke all on function public.personal_bank_unreconcile(uuid) from public, anon;
grant execute on function public.personal_bank_unreconcile(uuid) to authenticated, service_role;

commit;
