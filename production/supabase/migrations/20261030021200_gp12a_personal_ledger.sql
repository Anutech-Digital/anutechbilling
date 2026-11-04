-- deploy-peek: (to_regclass('public.personal_account_balances') is not null and exists(select 1 from pg_constraint where conname = 'personal_transactions_account_owner_fkey' and convalidated))
-- deploy-key: gp12apersonalledger
-- R-2127 (GP-12a, goal G-PERSONAL, 30 Oct 2026): the personal money ledger.
--
-- What changes, and what does NOT
--   * The owner RLS shape is untouched: every policy stays `owner_user_id = auth.uid() and
--     tenant_id = current_tenant_id()` (20260819170000_owner_personal_vault.sql:219-235).
--   * personal_transactions.kind CHECK is WIDENED, never narrowed — every existing row
--     (drawing / dividend / salary / interest / other_income / expense) still passes.
--     New: transfer_in, transfer_out, refund, card_payment, atm_cash.
--   * Import columns for bank/card statements (a later GP card builds the importer):
--     source, import_batch_id, reference, raw_description, balance_after, dedupe_hash —
--     and one partial unique key so the same statement line cannot land twice in one account.
--   * Composite FK (account_id, owner_user_id) → personal_accounts(id, owner_user_id).
--     The old single-column FK accepted ANY account id; RLS stops a browser from using
--     someone else's account, but a service-role statement import runs without RLS, so
--     the database itself must refuse "my transaction on your account".
--   * personal_accounts: opening_balance, statement_day, due_day, min_due.
--   * View personal_account_balances (security_invoker — the caller's RLS applies):
--     balance = opening_balance + credits - debits.
--
-- Decision (card needsDecision, recommended option taken — Pardeep delegates):
--   the balance is COMPUTED from transactions. The old hand-typed
--   personal_accounts.balance column is left as it is (the current screens still read
--   it); moving the screens to the view is a later GP card. No data is rewritten here:
--   opening_balance starts at 0 for existing accounts.
--
-- Direction of each kind (amount is always positive; direction comes from kind):
--   credit (money into the account):  drawing, dividend, salary, interest, other_income,
--                                     transfer_in, refund
--   debit  (money out of the account): expense, transfer_out, atm_cash
--   card_payment: a DEBIT on a bank/cash account (money leaves to pay the card) and a
--                 CREDIT on a credit_card account (the payment reduces what is owed).
--   Spend = expense - refund. card_payment, transfers and ATM cash move money between
--   your own pockets; counting them as spend would count the same rupee twice.
--
-- credit_card sign: like personal_accounts.balance, a card's balance is what is OWED,
--   held positive: owed = opening_balance + debits - credits.

begin;

-- ─── 1. widen the kind CHECK ───────────────────────────────────────────────
-- The original CHECK was declared inline, so Postgres named it; find it by its
-- definition instead of trusting the generated name.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.personal_transactions'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%kind%'
  loop
    execute format('alter table public.personal_transactions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.personal_transactions
  add constraint personal_transactions_kind_check check (kind in (
    'drawing', 'dividend', 'salary', 'interest', 'other_income', 'expense',
    'transfer_in', 'transfer_out', 'refund', 'card_payment', 'atm_cash'));

-- ─── 2. import columns ─────────────────────────────────────────────────────
alter table public.personal_transactions
  add column if not exists source          text not null default 'manual',
  add column if not exists import_batch_id uuid,
  add column if not exists reference       text,
  add column if not exists raw_description text,
  add column if not exists balance_after   bigint,
  add column if not exists dedupe_hash     text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_source_check') then
    alter table public.personal_transactions
      add constraint personal_transactions_source_check check (source in ('manual', 'import'));
  end if;
end $$;

comment on column public.personal_transactions.source is
  'manual = typed on the screen; import = came from a bank/card statement (import_batch_id says which upload).';
comment on column public.personal_transactions.balance_after is
  'The running balance the BANK printed on the statement line, whole rupees. A check figure for the import, never the source of the account balance (that is personal_account_balances).';
comment on column public.personal_transactions.dedupe_hash is
  'Hash of the statement line, set by the importer. Unique per (owner, account) so re-uploading an overlapping statement does not double the money.';

create unique index if not exists personal_transactions_dedupe_uq
  on public.personal_transactions (owner_user_id, account_id, dedupe_hash)
  where dedupe_hash is not null;

-- ─── 3. owner-safe composite FK ────────────────────────────────────────────
-- The referenced pair must be unique first (id alone already is; the pair is what the FK needs).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'personal_accounts_id_owner_key') then
    alter table public.personal_accounts
      add constraint personal_accounts_id_owner_key unique (id, owner_user_id);
  end if;
end $$;

-- Fail loudly, with the count, if any existing row already points at another person's
-- account. Never "fix" such a row here: which side is right is a data-repair decision.
do $$
declare n bigint;
begin
  select count(*) into n
    from public.personal_transactions t
    join public.personal_accounts a on a.id = t.account_id
   where a.owner_user_id <> t.owner_user_id;
  if n > 0 then
    raise exception 'R-2127: % personal_transactions row(s) point at an account owned by someone else — repair them before this migration (composite FK would fail)', n;
  end if;
end $$;

-- `set null (account_id)`: deleting an account keeps its transactions as cash rows,
-- exactly like the old FK — and leaves owner_user_id alone (it is NOT NULL).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_account_owner_fkey') then
    alter table public.personal_transactions
      add constraint personal_transactions_account_owner_fkey
      foreign key (account_id, owner_user_id)
      references public.personal_accounts (id, owner_user_id)
      on delete set null (account_id)
      not valid;
  end if;
end $$;

alter table public.personal_transactions validate constraint personal_transactions_account_owner_fkey;

-- The old single-column FK is now a weaker copy of the composite one; with two FKs on
-- the same column a delete would fire two "set null" actions. Drop it.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.personal_transactions'::regclass
       and contype = 'f'
       and confrelid = 'public.personal_accounts'::regclass
       and conname <> 'personal_transactions_account_owner_fkey'
  loop
    execute format('alter table public.personal_transactions drop constraint %I', c.conname);
  end loop;
end $$;

create index if not exists personal_transactions_account_idx
  on public.personal_transactions (account_id, owner_user_id)
  where account_id is not null;

-- ─── 4. account fields for opening balance and card cycle ──────────────────
alter table public.personal_accounts
  add column if not exists opening_balance bigint   not null default 0,
  add column if not exists statement_day   smallint,
  add column if not exists due_day         smallint,
  add column if not exists min_due         bigint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'personal_accounts_cycle_days_check') then
    alter table public.personal_accounts
      add constraint personal_accounts_cycle_days_check check (
        (statement_day is null or statement_day between 1 and 31)
        and (due_day is null or due_day between 1 and 31)
        and (min_due is null or min_due >= 0));
  end if;
end $$;

comment on column public.personal_accounts.opening_balance is
  'Whole rupees on the day tracking starts. For credit_card: the amount OWED then, held positive. personal_account_balances adds transactions to this.';
comment on column public.personal_accounts.statement_day is 'Credit card: day of month the statement is generated (1-31).';
comment on column public.personal_accounts.due_day is 'Credit card: day of month payment is due (1-31).';
comment on column public.personal_accounts.min_due is 'Credit card: minimum amount due on the latest statement, whole rupees.';

-- ─── 5. computed balances ──────────────────────────────────────────────────
create or replace view public.personal_account_balances
with (security_invoker = true) as
with dir as (
  select t.account_id,
         t.amount,
         t.kind,
         case
           when t.kind in ('drawing', 'dividend', 'salary', 'interest', 'other_income', 'transfer_in', 'refund') then 1
           when t.kind = 'card_payment' and a.kind = 'credit_card' then 1
           else -1
         end as sign
    from public.personal_transactions t
    join public.personal_accounts a on a.id = t.account_id and a.owner_user_id = t.owner_user_id
)
select a.id                             as account_id,
       a.tenant_id,
       a.owner_user_id,
       a.kind                           as account_kind,
       a.label,
       a.opening_balance,
       coalesce(s.credits, 0)::bigint   as credits,
       coalesce(s.debits, 0)::bigint    as debits,
       coalesce(s.spend, 0)::bigint     as spend,
       coalesce(s.txn_count, 0)::bigint as txn_count,
       (case when a.kind = 'credit_card'
             then a.opening_balance + coalesce(s.debits, 0) - coalesce(s.credits, 0)
             else a.opening_balance + coalesce(s.credits, 0) - coalesce(s.debits, 0)
        end)::bigint                    as balance
  from public.personal_accounts a
  left join (
    select account_id,
           sum(amount) filter (where sign = 1)  as credits,
           sum(amount) filter (where sign = -1) as debits,
           sum(case when kind = 'expense' then amount when kind = 'refund' then -amount else 0 end) as spend,
           count(*) as txn_count
      from dir
     group by account_id
  ) s on s.account_id = a.id;

comment on view public.personal_account_balances is
  'R-2127: per-account computed balance. Non-card: opening + credits - debits. credit_card: amount OWED = opening + debits - credits. spend = expense - refund (card_payment, transfers and ATM cash are not spend). security_invoker: the caller''s owner_user_id = auth.uid() policy decides which rows exist.';

revoke all on public.personal_account_balances from anon, public;
grant select on public.personal_account_balances to authenticated, service_role;

commit;
