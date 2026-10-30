-- deploy-peek: to_regclass('public.other_incomes') is not null and to_regprocedure('public.book_bank_credit_as_other_income(uuid,text,text)') is not null and to_regprocedure('public.reconcile_bank_txn_as_transfer(uuid,uuid)') is not null and to_regprocedure('public.report_pnl_other_income(date,date)') is not null
-- deploy-key: r2095otherincomefdtransfer
-- 20261030140000_r2095_other_income_fd_transfer.sql
--
-- R-2095 (30 Oct 2026, September reconcile on staging), P1:
--   1. Interest credited by the bank (FD / savings interest) could only be "marked reconciled
--      manually" — it reached no income line, so the P&L missed it. A money-in line can now be
--      booked as OTHER INCOME (head 'interest' = Interest received, or 'other'):
--        other_incomes                      one row per bank line (bank_txn_id unique);
--        book_bank_credit_as_other_income   books + reconciles the line (matched_to_type
--                                           'other_income'), one transaction;
--        report_pnl_other_income(from, to)  the P&L's "Other income" lines (companion of
--                                           report_pnl, like report_pnl_revenue_by_product);
--        un-reconciling the line removes its row (trigger).
--   2. FD sweep-ins / sweep-outs were own transfers with no other side: the FD account never moved.
--      reconcile_bank_txn_as_transfer(line, other account) posts the line as a transfer with
--      another of the company's accounts (e.g. a 'fixed_deposit' account): it matches that
--      account's own unmatched opposite line (same amount, ±3 days, nearest first) or, when the
--      other account has no statement, adds the opposite line there (reference OWN-TRANSFER).
--      Un-reconciling either side frees the other; an added line is removed with it.
-- Test: supabase/tests/r2095_other_income_fd_transfer.test.sql

begin;

-- ── 1. Other income ──────────────────────────────────────────────────────────────────────
create table if not exists public.other_incomes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  bank_txn_id uuid not null unique references public.bank_transactions(id) on delete cascade,
  income_date date not null,
  amount      integer not null check (amount > 0),
  head        text not null check (head in ('interest', 'other')),
  description text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
comment on table public.other_incomes is
  'R-2095: income that is not a sale, booked from a money-in bank line — interest received (FD / savings) or other. P&L "Other income" (report_pnl_other_income).';
create index if not exists other_incomes_tenant_date_idx on public.other_incomes (tenant_id, income_date);
alter table public.other_incomes enable row level security;
drop policy if exists other_incomes_tenant_read on public.other_incomes;
create policy other_incomes_tenant_read on public.other_incomes
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
drop policy if exists zzz_service_role_all on public.other_incomes;
create policy zzz_service_role_all on public.other_incomes as permissive for all to service_role
  using (true) with check (true);
revoke all on table public.other_incomes from anon;
grant select on table public.other_incomes to authenticated;
grant all on table public.other_incomes to service_role;

-- matched_to_type gains 'other_income' (R-1864's pattern: read the live list, add one).
do $$
declare v_def text; v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.bank_transactions'::regclass and c.conname = 'bank_transactions_matched_to_type_check';
  if v_def is null then raise exception 'bank_transactions_matched_to_type_check is missing'; end if;
  if v_def ~ '\{[a-z_,]+\}' then
    v_vals := string_to_array(substring(v_def from '\{([a-z_,]+)\}'), ',');
  else
    select array_agg(m[1] order by ord) into v_vals
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;
  if v_vals is null or cardinality(v_vals) = 0 then raise exception 'Could not read bank_transactions_matched_to_type_check: %', v_def; end if;
  if 'other_income' = any (v_vals) then return; end if;
  v_vals := array_append(v_vals, 'other_income'::text);
  execute 'alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check';
  execute format('alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check check (matched_to_type = any (%L::text[]))', v_vals);
end $$;

create or replace function public.book_bank_credit_as_other_income(p_txn_id uuid, p_head text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
/* R-2095: a money-in line → other income (interest received / other), reconciled, one transaction. */
declare
  v_trusted boolean;
  v_caller  uuid;
  v_txn     record;
  v_id      uuid;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can book a bank line' using errcode = '42501';
  end if;
  if p_head is null or p_head not in ('interest', 'other') then
    raise exception 'Pick what this income is: interest received or other income.' using errcode = '22023';
  end if;
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can be income.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  insert into public.other_incomes (tenant_id, bank_txn_id, income_date, amount, head, description, created_by)
  values (v_txn.tenant_id, v_txn.id, v_txn.txn_date, v_txn.credit, p_head,
          coalesce(nullif(btrim(p_note), ''), case p_head when 'interest' then 'Interest received' else 'Other income' end
            || ' · ' || coalesce(nullif(btrim(v_txn.description), ''), 'bank line')),
          auth.uid())
  returning id into v_id;
  perform public.reconcile_bank_txn(p_txn_id, 'other_income', v_id::text, 'manual');
  return v_id;
end;
$$;
revoke all on function public.book_bank_credit_as_other_income(uuid, text, text) from public, anon;
grant execute on function public.book_bank_credit_as_other_income(uuid, text, text) to authenticated, service_role;

create or replace function public.report_pnl_other_income(p_from date, p_to date)
returns table(head text, amount bigint, n integer)
language sql
stable
set search_path = public
as $$
  /* R-2095: the P&L's Other income lines (RLS: the caller's company only). */
  select o.head, sum(o.amount)::bigint, count(*)::int
    from public.other_incomes o
   where o.tenant_id = public.current_tenant_id() and o.income_date between p_from and p_to
   group by o.head
   order by o.head;
$$;
revoke all on function public.report_pnl_other_income(date, date) from public, anon;
grant execute on function public.report_pnl_other_income(date, date) to authenticated, service_role;

-- ── 2. Own transfer with another account (FD sweep) ──────────────────────────────────────
create or replace function public.reconcile_bank_txn_as_transfer(p_txn_id uuid, p_other_account uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2095: a bank line posted as a transfer with another of the company's accounts (FD sweep). */
declare
  v_trusted boolean;
  v_caller  uuid;
  v_txn     record;
  v_other   record;
  v_mine    record;
  v_pair    uuid;
  v_added   boolean := false;
  v_amount  integer;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a transfer between accounts' using errcode = '42501';
  end if;
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;
  select a.id, a.name into v_other from public.bank_accounts a
   where a.id = p_other_account and a.tenant_id = v_txn.tenant_id;
  if not found then raise exception 'The other account is not one of your accounts.' using errcode = 'no_data_found'; end if;
  if p_other_account = v_txn.bank_account_id then
    raise exception 'Pick the OTHER account — money cannot move within one account.' using errcode = '22023';
  end if;
  select a.name into v_mine from public.bank_accounts a where a.id = v_txn.bank_account_id;
  v_amount := greatest(coalesce(v_txn.credit, 0), coalesce(v_txn.debit, 0));

  /* The other account's own statement line, when it has one: opposite side, same amount, ±3 days. */
  select t.id into v_pair from public.bank_transactions t
   where t.tenant_id = v_txn.tenant_id and t.bank_account_id = p_other_account
     and t.matched_to_type is null
     and (case when coalesce(v_txn.credit, 0) > 0 then t.debit else t.credit end) = v_amount
     and abs(t.txn_date - v_txn.txn_date) <= 3
   order by abs(t.txn_date - v_txn.txn_date), t.created_at
   limit 1
   for update;
  if v_pair is null then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source)
    values
      (v_txn.tenant_id, p_other_account, v_txn.txn_date,
       case when coalesce(v_txn.credit, 0) > 0 then 'Transfer to ' else 'Transfer from ' end || coalesce(v_mine.name, 'bank account'),
       case when coalesce(v_txn.credit, 0) > 0 then v_amount else 0 end,
       case when coalesce(v_txn.credit, 0) > 0 then 0 else v_amount end,
       'OWN-TRANSFER', 'manual')
    returning id into v_pair;
    v_added := true;
  end if;

  perform public.reconcile_bank_txn(p_txn_id, 'transfer', v_pair::text, 'manual');
  perform public.reconcile_bank_txn(v_pair, 'transfer', p_txn_id::text, 'manual');
  return jsonb_build_object('pair_id', v_pair, 'added', v_added, 'other_account', v_other.name);
end;
$$;
revoke all on function public.reconcile_bank_txn_as_transfer(uuid, uuid) from public, anon;
grant execute on function public.reconcile_bank_txn_as_transfer(uuid, uuid) to authenticated, service_role;

-- Un-reconciling: an other-income line drops its row; a transfer frees its pair (a pair line this
-- function added is removed).
create or replace function public.tg_bank_txn_unmatched_r2095()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_pair record;
begin
  if old.matched_to_type is not distinct from new.matched_to_type
     and old.matched_to_id is not distinct from new.matched_to_id then
    return new;
  end if;
  if old.matched_to_type = 'other_income' then
    delete from public.other_incomes where bank_txn_id = old.id;
  end if;
  if old.matched_to_type = 'transfer' and old.matched_to_id ~* '^[0-9a-f-]{36}$' then
    select t.id, t.reference, t.source, t.import_batch_id, t.matched_to_type, t.matched_to_id into v_pair
      from public.bank_transactions t
     where t.id = old.matched_to_id::uuid and t.tenant_id = old.tenant_id;
    if found and v_pair.matched_to_type = 'transfer' and v_pair.matched_to_id = old.id::text then
      if v_pair.reference = 'OWN-TRANSFER' and v_pair.source = 'manual' and v_pair.import_batch_id is null then
        delete from public.bank_transactions where id = v_pair.id;
      else
        update public.bank_transactions
           set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
         where id = v_pair.id;
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_bank_txn_unmatched_r2095() from public, anon, authenticated;

drop trigger if exists trg_bank_txn_unmatched_r2095 on public.bank_transactions;
create trigger trg_bank_txn_unmatched_r2095
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_bank_txn_unmatched_r2095();

commit;
