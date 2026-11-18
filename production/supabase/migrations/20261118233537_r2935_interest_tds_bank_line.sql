-- deploy-peek: to_regprocedure('public.book_bank_debit_as_interest_tds(uuid,uuid)') is not null and to_regprocedure('public.bank_interest_without_tds(uuid)') is not null and to_regprocedure('public.tg_bank_txn_tds_line_r2935()') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_other_income_deleted_r2366()') and prosrc like '%R-2935%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_match_target_tenant(text,text)') and prosrc like '%R-2935%') and exists(select 1 from pg_constraint where conname = 'bank_transactions_matched_to_type_check' and pg_get_constraintdef(oid) like '%tds_receivable%')
-- deploy-key: r2935interesttdsbankline
-- 20261118233537_r2935_interest_tds_bank_line.sql
--
-- R-2935 (staging 18 Nov 2026, Excel HDFC 4523 reconcile), P1.
-- HDFC pays a closed FD on THREE bank lines: "FD REDEEM PRINCIPAL" (+₹10,00,000, an own transfer),
-- "FD REDEEM INTEREST" (+₹8,014 — the GROSS interest) and "FD REDEEM TAX" (−₹801 — the TDS the bank
-- cut, Sec 194A). R-2366's interest booking knew only TDS that never reached the bank (typed next
-- to the interest, income grossed up). The money-OUT tax line had no way at all: it is not a
-- challan the company paid (Tax → TDS clears TDS *payable*) and it is not an expense.
--
--   book_bank_debit_as_interest_tds(tax line, interest row)
--     The line is the TDS on an interest already booked from its own bank line (other_incomes,
--     head 'interest', source fd / savings / other, no TDS on it yet):
--       Dr TDS receivable = line (tds_receivable, 194A, gross = the interest, net = interest − TDS)
--       Cr Bank           = line
--     The interest row keeps its amount (it was credited gross) and now carries tds_amount,
--     tds_receivable_id and tds_txn_id (the tax line). The line is reconciled as the new
--     matched_to_type 'tds_receivable' + the tds_receivable id — never 'expense', never 'statutory'.
--     Refused: not money out / already reconciled / interest of another company / interest that
--     already has TDS / loan interest (the borrower cuts that TDS — R-2376) / TDS ≥ the interest.
--   bank_interest_without_tds(tax line) — the interest rows this line can be the TDS of (±45 days).
--   Un-reconcile, either side, leaves nothing behind (tg_bank_txn_tds_line_r2935 +
--   tg_other_income_deleted_r2366): un-reconciling / deleting the tax line removes the TDS row and
--   clears the interest row's TDS; un-reconciling the interest line frees the tax line too.
--   A TDS row already claimed in the ITR refuses both.
-- No data repair. Test: supabase/tests/r2935_interest_tds_bank_line.test.sql (begin … rollback).

begin;

-- ── 1. matched_to_type gains 'tds_receivable' (R-2374's pattern: read the live list, add one) ──
do $$
declare v_def text; v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = to_regclass('public.bank_transactions') and c.conname = 'bank_transactions_matched_to_type_check';
  if v_def is null then raise exception 'bank_transactions_matched_to_type_check is missing'; end if;
  if v_def ~ '\{[a-z_,]+\}' then
    v_vals := string_to_array(substring(v_def from '\{([a-z_,]+)\}'), ',');
  else
    select array_agg(m[1] order by ord) into v_vals
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;
  if v_vals is null or cardinality(v_vals) = 0 then raise exception 'Could not read bank_transactions_matched_to_type_check: %', v_def; end if;
  if 'tds_receivable' = any (v_vals) then return; end if;
  v_vals := array_append(v_vals, 'tds_receivable');
  execute 'alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check';
  execute format('alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check check (matched_to_type = any (%L::text[]))', v_vals);
end $$;

alter table public.other_incomes
  add column if not exists tds_txn_id uuid;
comment on column public.other_incomes.tds_txn_id is
  'R-2935: the bank''s own money-out TDS line for this interest (book_bank_debit_as_interest_tds). Set → amount is the bank credit itself (already gross); null with tds_amount > 0 → R-2366: amount = credit + TDS.';
comment on column public.other_incomes.amount is
  'Income booked (gross). R-2366: for interest with TDS typed next to it = interest credited + TDS deducted. R-2935: with tds_txn_id (TDS on its own bank line) = the bank credit.';
create unique index if not exists other_incomes_tds_txn_id_key
  on public.other_incomes (tds_txn_id) where tds_txn_id is not null;

-- ── 2. The company gate learns the new type (from R-2570's body, one line added) ──
create or replace function public.bank_match_target_tenant(p_type text, p_id text)
 returns uuid
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
/* R-2472: the company that owns record p_id in the table match type p_type points at;
   null = no such record (or a type this helper does not know). */
declare
  v_uuid uuid := public.bank_match_uuid(p_id);
begin
  if p_id is null then return null; end if;
  return case p_type
    when 'expense'        then (select x.tenant_id from public.expenses x                where x.id = p_id)
    when 'vendor_bill'    then (select x.tenant_id from public.vendor_bills x            where x.id = p_id)
    when 'payment'        then (select x.tenant_id from public.payments x                where x.id = v_uuid)
    when 'project'        then (select x.tenant_id from public.project_payments x        where x.id = v_uuid)
    when 'salary'         then (select x.tenant_id from public.salary_payments x         where x.id = v_uuid)
    when 'transfer'       then (select x.tenant_id from public.bank_transactions x       where x.id = v_uuid)
    when 'other_income'   then (select x.tenant_id from public.other_incomes x           where x.id = v_uuid)
    when 'loan_given'     then coalesce((select x.tenant_id from public.loan_repayments x where x.id = v_uuid),
                                        (select x.tenant_id from public.loans_given x     where x.id = v_uuid))
    when 'business_loan'  then (select x.tenant_id from public.business_loans x          where x.id = v_uuid)
    when 'loan_drawdown'  then (select x.tenant_id from public.business_loan_drawdowns x where x.id = v_uuid)
    when 'loan_repayment' then (select x.tenant_id from public.business_loan_payments x  where x.id = v_uuid)
    -- R-2570: the types the own-line writers now set
    when 'bs_item'        then (select x.tenant_id from public.balance_sheet_items x     where x.id = v_uuid)
    when 'employee_loan'  then (select x.tenant_id from public.employee_loans x          where x.id = v_uuid)
    -- 'reimbursement:<id>' (the shape the staff-advance flow writes) or a bare id — both are checked
    when 'reimbursement'  then (select x.tenant_id from public.reimbursements x
                                 where x.id = coalesce(v_uuid, public.bank_match_uuid(substr(p_id, length('reimbursement:') + 1))))
    when 'statutory'      then (select x.tenant_id from public.statutory_dues_payments x where x.id = v_uuid)
    -- R-2935: the bank's own TDS line on interest (tds_receivable.id is text)
    when 'tds_receivable' then (select x.tenant_id from public.tds_receivable x          where x.id = p_id)
    else null
  end;
end;
$function$;

-- ── 3. The interest rows a money-out TDS line can belong to ──
create or replace function public.bank_interest_without_tds(p_txn_id uuid)
returns table (id uuid, income_date date, amount integer, description text, source text, fd_name text)
language sql
stable
security definer
set search_path = public
as $$
  /* R-2935: bank interest (R-2366 rows: source fd / savings / other) of the line's own company,
     with no TDS on it yet, bigger than the line, within 45 days — nearest date first. */
  select o.id, o.income_date, o.amount, o.description, o.source, a.name
    from public.bank_transactions t
    join public.other_incomes o
      on o.tenant_id = t.tenant_id
     and o.head = 'interest' and o.source is not null
     and o.tds_amount = 0 and o.tds_receivable_id is null and o.tds_txn_id is null
     and o.amount > t.debit
     and abs(o.income_date - t.txn_date) <= 45
    left join public.bank_accounts a on a.id = o.fd_account_id
   where t.id = p_txn_id
     and t.tenant_id = public.current_tenant_id()
     and coalesce(t.debit, 0) > 0
   order by abs(o.income_date - t.txn_date), o.created_at
   limit 50
$$;
revoke all on function public.bank_interest_without_tds(uuid) from public, anon;
grant execute on function public.bank_interest_without_tds(uuid) to authenticated, service_role;

-- ── 4. Book the tax line ──
create or replace function public.book_bank_debit_as_interest_tds(
  p_txn_id          uuid,
  p_other_income_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2935: a money-out line that is the TDS a bank cut on interest already booked from its own
   line → TDS receivable (194A). Dr TDS receivable, Cr Bank; the income is not touched. */
declare
  v_trusted boolean;
  v_caller  uuid;
  v_txn     record;
  v_inc     record;
  v_bank    text;
  v_tds     integer;
  v_tds_row text;
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

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.debit, 0) <= 0 then
    raise exception 'Only a money-out (debit) bank line can be TDS the bank cut.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;
  v_tds := v_txn.debit;

  select o.* into v_inc from public.other_incomes o
   where o.id = p_other_income_id and o.tenant_id = v_txn.tenant_id for update;
  if not found then
    raise exception 'Pick the interest this TDS was cut on — book the interest line first.' using errcode = 'no_data_found';
  end if;
  if v_inc.head is distinct from 'interest' or v_inc.source is null then
    raise exception 'This is not interest received from a bank — a bank''s TDS line goes only with bank interest (FD / savings).'
      using errcode = '22023';
  end if;
  if v_inc.tds_amount > 0 or v_inc.tds_receivable_id is not null or v_inc.tds_txn_id is not null then
    raise exception 'TDS is already booked on this interest (₹%). Pick another interest line.', v_inc.tds_amount
      using errcode = 'check_violation';
  end if;
  if v_tds >= v_inc.amount then
    raise exception 'TDS ₹% cannot be the whole interest ₹% or more. Pick the right interest line.', v_tds, v_inc.amount
      using errcode = '22023';
  end if;

  select coalesce(nullif(btrim(fd.bank_name), ''), nullif(btrim(mine.bank_name), ''), 'Bank') into v_bank
    from public.bank_accounts mine
    left join public.bank_accounts fd on fd.id = v_inc.fd_account_id
   where mine.id = v_txn.bank_account_id;

  v_tds_row := 'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
  insert into public.tds_receivable (
    id, tenant_id, invoice_id, payment_id, customer_id, customer_name, section, rate_pct,
    gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, status, notes
  ) values (
    v_tds_row, v_txn.tenant_id, null, null, null, coalesce(v_bank, 'Bank'),
    '194A', round(v_tds * 100.0 / v_inc.amount, 2),
    v_inc.amount, v_tds, v_inc.amount - v_tds,
    public.indian_fiscal_year(v_inc.income_date), v_txn.txn_date, 'pending_cert',
    'R-2935: TDS on interest (bank''s own line) · bank line ' || v_txn.id::text
  );

  update public.other_incomes
     set tds_amount = v_tds, tds_receivable_id = v_tds_row, tds_txn_id = v_txn.id
   where id = v_inc.id;

  update public.bank_transactions
     set matched_to_type = 'tds_receivable', matched_to_id = v_tds_row,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual',
         updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object('tds_receivable_id', v_tds_row, 'tds', v_tds, 'interest', v_inc.amount,
                            'net', v_inc.amount - v_tds, 'other_income_id', v_inc.id,
                            'rate_pct', round(v_tds * 100.0 / v_inc.amount, 2));
end;
$$;
revoke all on function public.book_bank_debit_as_interest_tds(uuid, uuid) from public, anon;
grant execute on function public.book_bank_debit_as_interest_tds(uuid, uuid) to authenticated, service_role;

-- ── 5. The tax line un-reconciled / re-matched / deleted → its TDS row goes, the interest row is plain again ──
create or replace function public.tg_bank_txn_tds_line_r2935()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2935 */
declare v_claimed boolean;
begin
  if old.matched_to_type is distinct from 'tds_receivable' or old.matched_to_id is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and new.matched_to_type is not distinct from old.matched_to_type
     and new.matched_to_id is not distinct from old.matched_to_id then
    return new;
  end if;
  /* Only the row book_bank_debit_as_interest_tds made for THIS line (its notes end in the line's id)
     — a line pointed at some other TDS row by hand never deletes that row. */
  select t.claimed_in_itr into v_claimed from public.tds_receivable t
   where t.id = old.matched_to_id and t.tenant_id = old.tenant_id
     and t.notes like 'R-2935:%bank line ' || old.id::text;
  if found then
    if v_claimed then
      raise exception 'This TDS is already claimed in the ITR — it cannot be undone here.' using errcode = 'check_violation';
    end if;
    delete from public.tds_receivable where id = old.matched_to_id and tenant_id = old.tenant_id;
  end if;
  /* The interest row is plain again even when the TDS row was already removed on the TDS page. */
  update public.other_incomes
     set tds_amount = 0, tds_receivable_id = null, tds_txn_id = null
   where tds_txn_id = old.id and tenant_id = old.tenant_id;
  return coalesce(new, old);
end;
$$;
revoke all on function public.tg_bank_txn_tds_line_r2935() from public, anon, authenticated;

drop trigger if exists trg_bank_txn_tds_line_unmatched_r2935 on public.bank_transactions;
create trigger trg_bank_txn_tds_line_unmatched_r2935
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_bank_txn_tds_line_r2935();
drop trigger if exists trg_bank_txn_tds_line_deleted_r2935 on public.bank_transactions;
create trigger trg_bank_txn_tds_line_deleted_r2935
  before delete on public.bank_transactions
  for each row execute function public.tg_bank_txn_tds_line_r2935();

-- ── 6. The interest row going away frees its tax line too (R-2366's body + the tds_txn_id part) ──
create or replace function public.tg_other_income_deleted_r2366()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2366; R-2935: a TDS that came on its own bank line (tds_txn_id) — that line is freed. */
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
  if old.tds_txn_id is not null then
    update public.bank_transactions
       set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
     where id = old.tds_txn_id and tenant_id = old.tenant_id and matched_to_type = 'tds_receivable';
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

commit;
