-- deploy-peek: exists(select 1 from pg_constraint where conname = 'personal_transactions_income_source_check')
-- deploy-key: r2387personalincomesource
-- R-2387 (goal G-PERSONAL, 2 Nov 2026): Private Vault → Income & Expenses.
--
-- Pardeep (2 Nov): "income aur bhi source ho sakte hai … personal income expense manager bhi
-- hona chahiye". The screen offered only "Drawing" and "Expense". This adds what an income
-- entry needs on top of the existing kinds:
--
--   * income_source  — WHERE the money came from (Salary, Rent, Interest, Dividend, Business /
--                      freelance, Agriculture, Capital gains, Gift, Refund, Other). The ITR head
--                      (Salary / House property / Business or profession / Capital gains /
--                      Other sources / Exempt) is derived from it in code
--                      (lib/vault/personal/income-expense.ts), never stored twice.
--                      Each source maps to an EXISTING kind (salary→salary, interest→interest,
--                      dividend→dividend, refund→refund, the rest→other_income), so balances
--                      (personal_account_balances) need no change: all of them are credits.
--   * party          — who paid / who was paid (employer, tenant, shop). Optional text.
--   * repeat_monthly — "this comes every month" (salary, rent). No cron: the screen offers
--                      "Add this month's" and the owner presses it.
--
-- What does NOT change: the owner RLS (owner_user_id = auth.uid() and tenant_id =
-- current_tenant_id(), 20260819170000) — new columns on the same table sit under the same
-- policies. No existing row is rewritten: income_source starts NULL (the screen falls back
-- to the kind), repeat_monthly starts false.

begin;

alter table public.personal_transactions
  add column if not exists income_source  text,
  add column if not exists party          text,
  add column if not exists repeat_monthly boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_income_source_check') then
    alter table public.personal_transactions
      add constraint personal_transactions_income_source_check check (
        income_source is null
        or (
          income_source in ('salary', 'rent', 'interest', 'dividend', 'business', 'agriculture',
                            'capital_gains', 'gift', 'refund', 'other')
          -- a source only on money IN, and on the kind it belongs to
          and kind = case income_source
                       when 'salary'   then 'salary'
                       when 'interest' then 'interest'
                       when 'dividend' then 'dividend'
                       when 'refund'   then 'refund'
                       else 'other_income'
                     end
        )
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_party_len_check') then
    alter table public.personal_transactions
      add constraint personal_transactions_party_len_check check (party is null or length(party) <= 120);
  end if;
end $$;

comment on column public.personal_transactions.income_source is
  'R-2387: where money IN came from — salary, rent, interest, dividend, business, agriculture, capital_gains, gift, refund, other. Must match kind (salary/interest/dividend/refund use their own kind, the rest other_income). ITR head is derived in code. NULL on old rows and on non-income kinds.';
comment on column public.personal_transactions.party is
  'R-2387: who paid or was paid (employer, tenant, shop). Free text, up to 120 characters.';
comment on column public.personal_transactions.repeat_monthly is
  'R-2387: the owner marked this entry as monthly (salary, rent). The screen offers "Add this month''s" — nothing is created automatically.';

commit;
