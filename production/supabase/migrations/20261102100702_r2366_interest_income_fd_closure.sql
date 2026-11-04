-- deploy-peek: to_regprocedure('public.book_bank_credit_as_interest(uuid,text,uuid,integer,integer,integer,text)') is not null and to_regprocedure('public.tg_other_income_deleted_r2366()') is not null and to_regprocedure('public.tg_bank_txn_unmatched_r2366()') is not null
-- deploy-key: r2366interestincomefdclosure
-- 20261102100702_r2366_interest_income_fd_closure.sql
--
-- R-2366 (2 Nov 2026, Pardeep: "app me interest income ka option banao"), P1.
-- Staging HDFC: FD premature closures (principal + interest, sometimes in ONE credit line) and
-- small interest credits could not be booked — R-2095's "Interest received" took the whole line as
-- income, and its Own transfer took the whole line as principal. Neither splits, neither knows TDS.
--
--   book_bank_credit_as_interest(line, source, fd account, principal, interest, tds, note)
--     source     'fd' | 'savings' | 'other' (where the interest came from)
--     principal  > 0 only for an FD closure: that part is the FD's own money coming back — an own
--                transfer FROM the FD account (the FD's statement line of that amount, ±3 days, is
--                matched when it has one, else a debit line is added there, reference
--                OWN-TRANSFER — R-2095's rule). Refused when more than the FD's balance.
--     interest   what the bank paid as interest on this line (net of TDS);
--                principal + interest must equal the bank line.
--     tds        TDS the bank deducted on the interest (Sec 194A) → a tds_receivable row
--                (Balance sheet → TDS receivable; claim it against 26AS / Form 16A).
--   MONEY (one transaction):
--     Dr Bank (line)  = principal + interest
--     Cr FD account   = principal                       (FD balance down)
--     Dr TDS receivable = tds
--     Cr Interest received (other_incomes, head 'interest') = interest + tds (gross)
--   → P&L "Other income → Interest received" = gross interest; no GST, not a sale.
--
--   other_incomes gains source, fd_account_id, principal_amount, fd_txn_id, tds_amount,
--   tds_receivable_id (all optional; R-2095 / R-2340 / R-2346 rows unchanged).
--   Un-reconcile: the bank line drops its other_incomes row (R-2095 trigger) → the new
--   tg_other_income_deleted_r2366 removes the TDS row and frees / removes the FD line.
--   Un-reconciling the FD line itself un-reconciles the bank line (same clean-up).
-- Test: supabase/tests/r2366_interest_income_fd_closure.test.sql

begin;

alter table public.other_incomes
  add column if not exists source            text,
  add column if not exists fd_account_id     uuid references public.bank_accounts(id) on delete restrict,
  add column if not exists principal_amount  integer not null default 0,
  add column if not exists fd_txn_id         uuid,
  add column if not exists tds_amount        integer not null default 0,
  add column if not exists tds_receivable_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'other_incomes_r2366_source_check') then
    alter table public.other_incomes add constraint other_incomes_r2366_source_check
      check (source is null or source in ('fd', 'savings', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'other_incomes_r2366_amounts_check') then
    alter table public.other_incomes add constraint other_incomes_r2366_amounts_check
      check (principal_amount >= 0 and tds_amount >= 0 and tds_amount < amount);
  end if;
end $$;

comment on column public.other_incomes.amount is
  'Income booked (gross). R-2366: for interest with TDS = interest credited + TDS deducted.';
comment on column public.other_incomes.principal_amount is
  'R-2366: FD closure — the part of the bank line that was the FD''s own principal (own transfer from fd_account_id, line fd_txn_id).';

create or replace function public.book_bank_credit_as_interest(
  p_txn_id     uuid,
  p_source     text,
  p_fd_account uuid,
  p_principal  integer,
  p_interest   integer,
  p_tds        integer,
  p_note       text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2366: a money-in line → interest income (FD / savings / other), optionally an FD closure
   (principal back from the FD) and TDS the bank deducted. One transaction. */
declare
  v_trusted   boolean;
  v_caller    uuid;
  v_txn       record;
  v_mine      record;
  v_fd        record;
  v_fd_name   text;
  v_fd_bank   text;
  v_principal integer := coalesce(p_principal, 0);
  v_interest  integer := coalesce(p_interest, 0);
  v_tds       integer := coalesce(p_tds, 0);
  v_fd_bal    bigint;
  v_fd_line   uuid;
  v_fd_added  boolean := false;
  v_tds_row   text;
  v_id        uuid;
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
  if p_source is null or p_source not in ('fd', 'savings', 'other') then
    raise exception 'Pick where the interest came from: FD, savings or other.' using errcode = '22023';
  end if;
  if v_principal < 0 or v_interest < 0 or v_tds < 0 then
    raise exception 'Amounts cannot be negative.' using errcode = '22023';
  end if;
  if v_interest <= 0 then
    raise exception 'Enter the interest part of this line (more than ₹0).' using errcode = '22023';
  end if;
  if v_principal > 0 and (p_source <> 'fd' or p_fd_account is null) then
    raise exception 'Principal coming back is only for an FD — pick the fixed deposit account.' using errcode = '22023';
  end if;
  if p_fd_account is not null and p_source <> 'fd' then
    raise exception 'An FD account goes only with interest from an FD.' using errcode = '22023';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can be interest income.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;
  if v_principal + v_interest <> v_txn.credit then
    raise exception 'Principal ₹% + interest ₹% must add up to the bank line ₹%.', v_principal, v_interest, v_txn.credit
      using errcode = '22023';
  end if;
  select a.name, a.bank_name into v_mine from public.bank_accounts a where a.id = v_txn.bank_account_id;

  if p_fd_account is not null then
    select a.id, a.name, a.bank_name, a.account_type, a.opening_balance into v_fd
      from public.bank_accounts a where a.id = p_fd_account and a.tenant_id = v_txn.tenant_id for update;
    if not found then raise exception 'The FD account is not one of your accounts.' using errcode = 'no_data_found'; end if;
    v_fd_name := v_fd.name;
    v_fd_bank := v_fd.bank_name;
    if v_fd.account_type is distinct from 'fixed_deposit' then
      raise exception '% is not a fixed deposit account.', v_fd.name using errcode = '22023';
    end if;
    if p_fd_account = v_txn.bank_account_id then
      raise exception 'Pick the FD account, not the account the money came into.' using errcode = '22023';
    end if;
  end if;

  if v_principal > 0 then
    /* The FD's own statement line, when it has one: money out, same amount, ±3 days. */
    select t.id into v_fd_line from public.bank_transactions t
     where t.tenant_id = v_txn.tenant_id and t.bank_account_id = p_fd_account
       and t.matched_to_type is null and t.debit = v_principal
       and abs(t.txn_date - v_txn.txn_date) <= 3
     order by abs(t.txn_date - v_txn.txn_date), t.created_at
     limit 1
     for update;
    if v_fd_line is null then
      /* No statement line: the principal leaves the FD now — never more than it holds. (With a
         statement line the outflow is already in its balance.) */
      select coalesce(v_fd.opening_balance, 0) + coalesce(sum(t.credit - t.debit), 0) into v_fd_bal
        from public.bank_transactions t
       where t.tenant_id = v_txn.tenant_id and t.bank_account_id = p_fd_account;
      if v_principal > v_fd_bal then
        raise exception 'Principal ₹% is more than % holds (₹%). Check the FD''s balance or the split.', v_principal, v_fd_name, v_fd_bal
          using errcode = '22023';
      end if;
      insert into public.bank_transactions
        (tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source)
      values
        (v_txn.tenant_id, p_fd_account, v_txn.txn_date,
         'FD closed — principal to ' || coalesce(v_mine.name, 'bank account'),
         v_principal, 0, 'OWN-TRANSFER', 'manual')
      returning id into v_fd_line;
      v_fd_added := true;
    end if;
    perform public.reconcile_bank_txn(v_fd_line, 'transfer', p_txn_id::text, 'manual');
  end if;

  if v_tds > 0 then
    v_tds_row := 'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
    insert into public.tds_receivable (
      id, tenant_id, invoice_id, payment_id, customer_id, customer_name, section, rate_pct,
      gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, status, notes
    ) values (
      v_tds_row, v_txn.tenant_id, null, null, null,
      coalesce(nullif(btrim(coalesce(v_fd_bank, v_mine.bank_name)), ''), 'Bank'),
      '194A', round(v_tds * 100.0 / (v_interest + v_tds), 2),
      v_interest + v_tds, v_tds, v_interest,
      public.indian_fiscal_year(v_txn.txn_date), v_txn.txn_date, 'pending_cert',
      'R-2366: TDS on interest · bank line ' || v_txn.id::text
    );
  end if;

  insert into public.other_incomes
    (tenant_id, bank_txn_id, income_date, amount, head, description, created_by,
     source, fd_account_id, principal_amount, fd_txn_id, tds_amount, tds_receivable_id)
  values
    (v_txn.tenant_id, v_txn.id, v_txn.txn_date, v_interest + v_tds, 'interest',
     coalesce(nullif(btrim(p_note), ''),
       case p_source when 'fd' then 'Interest on FD' when 'savings' then 'Interest on savings' else 'Interest received' end
       || coalesce(' · ' || v_fd_name, '') || ' · ' || coalesce(nullif(btrim(v_txn.description), ''), 'bank line')),
     auth.uid(), p_source, p_fd_account, v_principal, v_fd_line, v_tds, v_tds_row)
  returning id into v_id;
  perform public.reconcile_bank_txn(p_txn_id, 'other_income', v_id::text, 'manual');

  return jsonb_build_object('other_income_id', v_id, 'interest', v_interest + v_tds, 'tds', v_tds,
                            'principal', v_principal, 'fd_txn_id', v_fd_line, 'fd_added', v_fd_added,
                            'fd_account', v_fd_name);
end;
$$;
revoke all on function public.book_bank_credit_as_interest(uuid, text, uuid, integer, integer, integer, text) from public, anon;
grant execute on function public.book_bank_credit_as_interest(uuid, text, uuid, integer, integer, integer, text) to authenticated, service_role;

-- An interest row going away (un-reconcile, line deleted) takes its TDS row and its FD line along.
create or replace function public.tg_other_income_deleted_r2366()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2366 */
declare v_fd record; v_tds record;
begin
  if old.tds_receivable_id is not null then
    select t.id, t.claimed_in_itr into v_tds from public.tds_receivable t
     where t.id = old.tds_receivable_id and t.tenant_id = old.tenant_id;
    if found then
      if v_tds.claimed_in_itr then
        raise exception 'The TDS on this interest is already claimed in the ITR — it cannot be undone here.'
          using errcode = 'check_violation';
      end if;
      delete from public.tds_receivable where id = v_tds.id;
    end if;
  end if;
  if old.fd_txn_id is not null then
    select t.id, t.reference, t.source, t.import_batch_id, t.matched_to_type, t.matched_to_id into v_fd
      from public.bank_transactions t where t.id = old.fd_txn_id and t.tenant_id = old.tenant_id;
    if found and v_fd.matched_to_type = 'transfer' and v_fd.matched_to_id = old.bank_txn_id::text then
      if v_fd.reference = 'OWN-TRANSFER' and v_fd.source = 'manual' and v_fd.import_batch_id is null then
        delete from public.bank_transactions where id = v_fd.id;
      else
        update public.bank_transactions
           set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
         where id = v_fd.id;
      end if;
    end if;
  end if;
  return old;
end;
$$;
revoke all on function public.tg_other_income_deleted_r2366() from public, anon, authenticated;

drop trigger if exists trg_other_income_deleted_r2366 on public.other_incomes;
create trigger trg_other_income_deleted_r2366
  after delete on public.other_incomes
  for each row execute function public.tg_other_income_deleted_r2366();

-- Un-reconciling the FD side of a closure un-reconciles the bank line too (never half a closure).
create or replace function public.tg_bank_txn_unmatched_r2366()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2366 */
declare v_main uuid;
begin
  if old.matched_to_type is distinct from 'transfer'
     or (old.matched_to_type is not distinct from new.matched_to_type
         and old.matched_to_id is not distinct from new.matched_to_id) then
    return null;
  end if;
  select o.bank_txn_id into v_main from public.other_incomes o
   where o.fd_txn_id = old.id and o.tenant_id = old.tenant_id;
  if v_main is null then return null; end if;
  update public.bank_transactions
     set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
   where id = v_main and matched_to_type = 'other_income';
  if old.reference = 'OWN-TRANSFER' and old.source = 'manual' and old.import_batch_id is null then
    delete from public.bank_transactions where id = old.id;
  end if;
  return null;
end;
$$;
revoke all on function public.tg_bank_txn_unmatched_r2366() from public, anon, authenticated;

drop trigger if exists trg_bank_txn_unmatched_r2366 on public.bank_transactions;
create trigger trg_bank_txn_unmatched_r2366
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_bank_txn_unmatched_r2366();

commit;
