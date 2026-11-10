-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_bank_transactions_touch_updated_at' and tgrelid = to_regclass('public.bank_transactions'))
-- deploy-key: r2524banklinestouchupdatedat
-- 20261106100922_r2524_bank_lines_touch_updated_at.sql
--
-- R-2524 (6 Nov 2026, Pardeep: "bank entry to bahut slow reconcile ho rahi hai"): after every reconcile
-- save the bank account page re-read ALL of the account's lines (5,170 on HDFC ··4523). It now reads
-- only the lines changed since its last read (updated_at >= newest seen − 10 min) plus a row count —
-- which needs updated_at to move on every UPDATE. Until now nothing moved it: the column only had
-- its insert default (now()). Inserts keep that default; a delete shows up as a count mismatch and
-- the page reads everything again.
--
-- clock_timestamp(), not now(): a long transaction (auto-reconcile chunk) stamps the moment the row
-- changed, not the moment the transaction began. No data is changed by this migration.

create or replace function public.tg_bank_transactions_touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- R-2524: every change to a bank line moves updated_at, so the bank page can read only what changed.
  new.updated_at := clock_timestamp();
  return new;
end
$$;

revoke all on function public.tg_bank_transactions_touch_updated_at() from public, anon, authenticated;

drop trigger if exists trg_bank_transactions_touch_updated_at on public.bank_transactions;
create trigger trg_bank_transactions_touch_updated_at
  before update on public.bank_transactions
  for each row execute function public.tg_bank_transactions_touch_updated_at();

create index if not exists bank_transactions_account_updated_idx
  on public.bank_transactions (bank_account_id, updated_at);
