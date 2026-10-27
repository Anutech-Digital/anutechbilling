-- deploy-peek: to_regclass('public.owner_equity_movements') is not null and to_regprocedure('public.record_owner_equity_movement(text,date,integer,uuid,text,text)') is not null and to_regprocedure('public.book_bank_txn_as_owner_equity(uuid,text,text,uuid)') is not null and to_regprocedure('public.delete_owner_equity_movement(uuid)') is not null and to_regprocedure('public.book_bank_txn_as_incentive(uuid,uuid,text,integer)') is not null
-- deploy-key: r1839ownerequity
-- 20261024142228_r1839_owner_equity.sql
--
-- R-1839 (Pardeep, 24 Oct 2026): "proprietor company se jab proprietor paisa nikalta hai usko
-- account me manage kaise karte hai wo bhi hona chahiye".
--
-- ══ THE ACCOUNTING ══════════════════════════════════════════════════════════════════════
--   Proprietorship / partnership (per partner) / LLP partner: money the owner takes out of the
--   business is DRAWINGS. It reduces the owner's capital on the Balance Sheet. It is never an
--   expense: it never touches the P&L and is not deductible. Money the owner puts in is
--   CAPITAL INTRODUCED. Closing capital = opening + capital introduced + net profit − drawings.
--   A Pvt Ltd company has no drawings: what a director takes is salary (payroll), a loan
--   (Companies Act s.185), a reimbursement or a dividend — the existing paths. Both functions
--   below refuse a pvt_ltd company.
--
-- ══ THE DATA ═══════════════════════════════════════════════════════════════════════════
--   owner_equity_movements — one row per withdrawal / contribution, dated, in whole rupees,
--   against the bank or cash account the money left / reached, with the partner's name for a
--   firm. balance_sheet_items (the manual equity lines) has no date, account or partner, so a
--   new table: those manual lines stay exactly as they are (nothing is moved or changed).
--
--   Every movement has a bank/cash line (bank_txn_id, never null), so the account's book
--   balance always moves with it:
--     • record_owner_equity_movement — recorded by hand: a 'manual' line is added on the chosen
--       account (debit for drawings, credit for capital), the way give_loan / pay_vendor_bill
--       move cash. own_line = true. Petty Cash is just a cash account here.
--     • book_bank_txn_as_owner_equity — from the bank page (Reconcile): the imported line
--       itself. If an entry recorded by hand is picked (p_movement_id), its own manual line is
--       REMOVED and the entry moves onto the imported line — the same money is never in cash &
--       bank twice (the book_bank_txn_as_vendor_bill pattern).
--     • delete_owner_equity_movement — removes the entry and its own line; on an imported
--       line it frees the line (back to Unmatched) instead of deleting the statement.
--   Un-reconciling a line booked as drawings (reconcile_bank_txn → null) or deleting the line
--   removes the entry too (trigger + on delete cascade), so an entry never outlives its cash.
--
-- §17c guard on every function (trusted = service_role or a direct DB session); roles owner,
-- manager, accountant (the money roles of reconcile_bank_txn, without billing — this is the
-- owner's own money). Proof: supabase/tests/r1839_owner_equity.test.sql (one rollback).

begin;

-- ── 1. The table ─────────────────────────────────────────────────────────────────────────
create table if not exists public.owner_equity_movements (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  kind             text        not null check (kind in ('drawings', 'capital_introduced')),
  movement_date    date        not null,
  amount           integer     not null check (amount > 0),
  bank_account_id  uuid        not null references public.bank_accounts(id) on delete restrict,
  -- The line that moved the cash. Deleting the line deletes the entry (no entry without cash).
  bank_txn_id      uuid        not null unique references public.bank_transactions(id) on delete cascade,
  -- true = the line was added by record_owner_equity_movement (ours to delete / replace);
  -- false = an imported / hand-entered statement line booked from the bank page.
  own_line         boolean     not null default false,
  partner_name     text        check (partner_name is null or length(trim(partner_name)) between 1 and 200),
  note             text        check (note is null or length(note) <= 1000),
  created_by       uuid,
  created_at       timestamptz not null default now()
);

comment on table public.owner_equity_movements is
  'R-1839: owner drawings / capital introduced (proprietor, partners). Equity only — never P&L. Every row has its bank/cash line.';

create index if not exists owner_equity_movements_tenant_idx
  on public.owner_equity_movements (tenant_id, movement_date);

alter table public.owner_equity_movements enable row level security;

drop policy if exists "tenant isolation read" on public.owner_equity_movements;
drop policy if exists zzz_service_role_all on public.owner_equity_movements;
-- Reads: same company AND a money role. Writes only through the functions below.
create policy "tenant isolation read" on public.owner_equity_movements for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant')));
-- Cloud SQL has no BYPASSRLS: the service role needs its own policy.
create policy zzz_service_role_all on public.owner_equity_movements as permissive for all to service_role
  using (true) with check (true);

grant select on public.owner_equity_movements to authenticated;
grant select, insert, update, delete on public.owner_equity_movements to service_role;

-- ── 2. A bank line can be matched to an owner-equity entry ─────────────────────────────────
alter table public.bank_transactions drop constraint if exists bank_transactions_matched_to_type_check;
alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check
  check (matched_to_type = any (array['payment','expense','vendor_bill','transfer','salary','project','manual','split','statutory','prepaid','referral_commission','owner_equity']));

-- ── 3. Record by hand (a manual line on the chosen account) ────────────────────────────────
create or replace function public.record_owner_equity_movement(
  p_kind        text,
  p_date        date,
  p_amount      integer,
  p_account_id  uuid,
  p_partner     text default null,
  p_note        text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_type     text;
  v_acc      public.bank_accounts;
  v_partner  text := nullif(trim(coalesce(p_partner, '')), '');
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_id       uuid := gen_random_uuid();
  v_txn      uuid;
  v_desc     text;
begin
  /* R-1839: §17c guard + money role (production/CLAUDE.md). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can record owner drawings or capital' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('drawings', 'capital_introduced') then
    raise exception 'Pick drawings (money taken out) or capital introduced (money put in).';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type = 'pvt_ltd' then
    raise exception 'A Pvt Ltd company has no owner drawings or capital entries — money paid to a director is salary (Payroll), a loan (Loans given) or a reimbursement; money a shareholder puts in is share capital or a director''s loan.';
  end if;
  if v_type in ('partnership', 'llp') and v_partner is null then
    raise exception 'Pick the partner whose capital account this is.';
  end if;
  if p_date is null then raise exception 'Pick the date.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than ₹0.'; end if;
  if p_account_id is null then raise exception 'Pick the bank account or Petty Cash.'; end if;
  select * into v_acc from public.bank_accounts where id = p_account_id and tenant_id = v_tenant;
  if not found then raise exception 'That account is not in your company — pick another, or add it in Banking.'; end if;
  if v_acc.account_type = 'credit_card' then
    raise exception 'Pick a bank account or Petty Cash — a credit card is not where the owner''s money moves.';
  end if;

  v_desc := case p_kind when 'drawings' then 'Owner drawings' else 'Capital introduced' end
            || coalesce(' — ' || v_partner, '')
            || coalesce(' · ' || v_note, '');

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
     matched_to_type, matched_to_id, matched_at, matched_by, match_confidence)
  values
    (v_tenant, p_account_id, p_date, left(v_desc, 500),
     case when p_kind = 'drawings' then p_amount else 0 end,
     case when p_kind = 'capital_introduced' then p_amount else 0 end,
     'manual', 'owner_equity', v_id::text, now(), auth.uid(), 'manual')
  returning id into v_txn;

  insert into public.owner_equity_movements
    (id, tenant_id, kind, movement_date, amount, bank_account_id, bank_txn_id, own_line, partner_name, note, created_by)
  values
    (v_id, v_tenant, p_kind, p_date, p_amount, p_account_id, v_txn, true, v_partner, v_note, auth.uid());

  return v_id;
end;
$$;

revoke all on function public.record_owner_equity_movement(text, date, integer, uuid, text, text) from public, anon;
grant execute on function public.record_owner_equity_movement(text, date, integer, uuid, text, text) to authenticated, service_role;

-- ── 4. Book from the bank page (Reconcile) ─────────────────────────────────────────────────
create or replace function public.book_bank_txn_as_owner_equity(
  p_txn_id       uuid,
  p_partner      text default null,
  p_note         text default null,
  p_movement_id  uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_type     text;
  v_txn      public.bank_transactions;
  v_mov      public.owner_equity_movements;
  v_kind     text;
  v_amount   integer;
  v_partner  text := nullif(trim(coalesce(p_partner, '')), '');
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_id       uuid;
  v_synth    uuid;
begin
  /* R-1839: §17c guard + money role. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can book owner drawings or capital' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type = 'pvt_ltd' then
    raise exception 'A Pvt Ltd company has no owner drawings or capital entries — book a director''s salary in Payroll, a loan to a director in Loans given, or a reimbursement.';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Bank line not found in your company.';
  end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  v_kind   := case when coalesce(v_txn.debit, 0) > 0 then 'drawings' else 'capital_introduced' end;
  v_amount := greatest(coalesce(v_txn.debit, 0), coalesce(v_txn.credit, 0));

  if p_movement_id is not null then
    -- An entry recorded by hand earlier: its own line is replaced by this real one.
    select * into v_mov from public.owner_equity_movements
     where id = p_movement_id and tenant_id = v_tenant for update;
    if not found then raise exception 'That drawings / capital entry is not in your company.'; end if;
    if v_mov.kind <> v_kind then
      raise exception 'That entry is %, but this line is money %.',
        case v_mov.kind when 'drawings' then 'drawings (money out)' else 'capital introduced (money in)' end,
        case v_kind when 'drawings' then 'out' else 'in' end;
    end if;
    if v_mov.amount <> v_amount then
      raise exception 'That entry is ₹% but this line is ₹% — pick the entry with the same amount.', v_mov.amount, v_amount;
    end if;
    if v_mov.bank_account_id <> v_txn.bank_account_id then
      raise exception 'That entry was recorded on a different account — pick an entry from this account.';
    end if;
    if not v_mov.own_line then
      raise exception 'That entry is already matched to a bank line.';
    end if;
    v_synth := v_mov.bank_txn_id;
    if v_partner is null and v_type in ('partnership', 'llp') then v_partner := v_mov.partner_name; end if;
    update public.owner_equity_movements
       set bank_txn_id = p_txn_id, own_line = false, movement_date = v_txn.txn_date,
           partner_name = coalesce(v_partner, partner_name), note = coalesce(v_note, note)
     where id = v_mov.id;
    -- The old manual line goes; the trigger below must not take the entry with it (it now
    -- points at the real line), and on-delete-cascade no longer reaches it.
    delete from public.bank_transactions where id = v_synth;
    v_id := v_mov.id;
  else
    if v_type in ('partnership', 'llp') and v_partner is null then
      raise exception 'Pick the partner whose capital account this is.';
    end if;
    v_id := gen_random_uuid();
    insert into public.owner_equity_movements
      (id, tenant_id, kind, movement_date, amount, bank_account_id, bank_txn_id, own_line, partner_name, note, created_by)
    values
      (v_id, v_tenant, v_kind, v_txn.txn_date, v_amount, v_txn.bank_account_id, p_txn_id, false, v_partner,
       coalesce(v_note, nullif(trim(coalesce(v_txn.description, '')), '')), auth.uid());
  end if;

  update public.bank_transactions
     set matched_to_type = 'owner_equity', matched_to_id = v_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object('movement_id', v_id, 'kind', v_kind, 'amount', v_amount, 'replaced_line', v_synth);
end;
$$;

revoke all on function public.book_bank_txn_as_owner_equity(uuid, text, text, uuid) from public, anon;
grant execute on function public.book_bank_txn_as_owner_equity(uuid, text, text, uuid) to authenticated, service_role;

-- ── 5. Delete an entry ─────────────────────────────────────────────────────────────────────
create or replace function public.delete_owner_equity_movement(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_mov      public.owner_equity_movements;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can delete owner drawings or capital' using errcode = '42501';
  end if;
  select * into v_mov from public.owner_equity_movements where id = p_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That entry is not in your company.'; end if;

  if v_mov.own_line then
    -- Our own manual line: delete it (the entry goes with it, on delete cascade).
    delete from public.bank_transactions where id = v_mov.bank_txn_id;
  else
    -- A statement line: keep it, back to Unmatched (the trigger removes the entry).
    update public.bank_transactions
       set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null,
           match_confidence = null, updated_at = now()
     where id = v_mov.bank_txn_id;
  end if;
  delete from public.owner_equity_movements where id = p_id;
end;
$$;

revoke all on function public.delete_owner_equity_movement(uuid) from public, anon;
grant execute on function public.delete_owner_equity_movement(uuid) to authenticated, service_role;

-- ── 6. Un-reconciling the line removes the entry ───────────────────────────────────────────
create or replace function public.tg_owner_equity_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.matched_to_type = 'owner_equity'
     and (new.matched_to_type is distinct from 'owner_equity' or new.matched_to_id is distinct from old.matched_to_id) then
    delete from public.owner_equity_movements where bank_txn_id = old.id;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_owner_equity_line_unmatched() from public, anon;

drop trigger if exists trg_owner_equity_line_unmatched on public.bank_transactions;
create trigger trg_owner_equity_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_owner_equity_line_unmatched();

-- ── 7. A bank debit that is an employee's incentive / bonus (Pardeep, 24 Oct) ──────────────
--   "koi payment employee ko incentive dete hai uski bhi to ho sakti hai". An incentive is
--   SALARY for the employee: a Salaries expense (P&L), TDS u/s 192, on the payslip and Form 16 —
--   never drawings, never a plain expense outside payroll. Through payroll's own row:
--     (a) the employee has a salary record for that month → its incentive (Bonus) goes up by the
--         incentive, its TDS by the TDS deducted, its net by what was paid; the month's Salaries
--         expense goes up by the incentive. The line is linked to that salary (paid_amount
--         follows through sync_salary_paid_status, as for any salary line).
--     (b) no salary record that month → pay_salary (the Payroll screen's own RPC) with gross 0
--         and this incentive, then the line is linked to it.
--   incentive = amount paid (the line) + TDS deducted. TDS is what the user enters (the app
--   cannot know the year's slab here) — the screen says "TDS: check".
--   Un-reconciling the line frees it; the incentive stays on the salary (it was earned), which
--   then shows as part-paid until another line pays it.
create or replace function public.book_bank_txn_as_incentive(
  p_txn_id       uuid,
  p_employee_id  uuid,
  p_period       text,
  p_tds          integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_txn      public.bank_transactions;
  v_emp      public.employees;
  v_sp       public.salary_payments;
  v_tds      integer := greatest(coalesce(p_tds, 0), 0);
  v_inc      integer;
  v_sal_id   uuid;
  v_mode     text;
begin
  /* R-1839: §17c guard + payroll roles (pay_salary's: owner, manager, accountant). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can book an incentive' using errcode = '42501';
  end if;
  if p_period is null or p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Pick the month the incentive is for.'; end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'An incentive paid out must be a money-out line.'; end if;
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Pick the employee — that one is not in your company.'; end if;

  v_inc := v_txn.debit + v_tds;

  select * into v_sp from public.salary_payments
   where tenant_id = v_tenant and employee_id = p_employee_id and period = p_period for update;
  if found then
    -- (a) the month's salary record: add the incentive to it.
    update public.salary_payments
       set incentive = coalesce(incentive, 0) + v_inc,
           tds = tds + v_tds,
           net = net + v_txn.debit,
           notes = left(concat_ws(' · ', nullif(notes, ''), 'Incentive ₹' || v_inc || ' added from bank line ' || to_char(v_txn.txn_date, 'DD Mon YYYY')), 1000)
     where id = v_sp.id;
    if v_sp.expense_id is not null then
      update public.expenses
         set amount = amount + v_inc,
             description = case when description ilike '%incl. incentive%' then description else description || ' (incl. incentive)' end
       where id = v_sp.expense_id and tenant_id = v_tenant;
    end if;
    v_sal_id := v_sp.id;
    v_mode := 'added_to_month';
  else
    -- (b) no salary record that month: a one-off incentive record through payroll's own RPC.
    v_sal_id := public.pay_salary(p_employee_id, p_period, v_txn.txn_date, 0, 0, 0, 0, null,
                                  v_tds, 0, 0, 0, v_txn.bank_account_id, 'Incentive / bonus — from bank line', v_inc, 0, 0, null);
    v_mode := 'one_off';
  end if;

  update public.bank_transactions
     set matched_to_type = 'salary', matched_to_id = v_sal_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object('salary_id', v_sal_id, 'mode', v_mode, 'incentive', v_inc, 'tds', v_tds, 'paid', v_txn.debit);
end;
$$;

revoke all on function public.book_bank_txn_as_incentive(uuid, uuid, text, integer) from public, anon;
grant execute on function public.book_bank_txn_as_incentive(uuid, uuid, text, integer) to authenticated, service_role;

commit;
