-- deploy-peek: to_regclass('public.employee_advance_bank_links') is not null and to_regprocedure('public.book_bank_txn_as_employee_advance(uuid,text,text,uuid,uuid,text)') is not null and to_regprocedure('public.add_employee_advance_bills(uuid,jsonb,boolean)') is not null and exists(select 1 from pg_trigger where tgname = 'trg_employee_advance_line_unmatched')
-- deploy-key: r1871empadvancebank
--
-- R-1871 (Pardeep, 24 Oct 2026): "employee advance for office expenses ka bhi system banaye
-- reconcile karte waqt".
--
-- ══ THE ACCOUNTING ══════════════════════════════════════════════════════════════════════
--   Money given to an employee to spend on office expenses (imprest) is NOT an expense when it
--   is given: it is company money in the employee's hand — an asset (R-101: a prepaid_advances
--   row with category 'Employee advance'). The expense is booked only when the bills come in,
--   in each bill's own category, with GST input credit where it is a valid GST bill (the P&L's
--   ITC rule, lib/gst/itc.ts). Money handed back reduces the advance. If the bills are more
--   than the advance, the extra is owed TO the employee — a reimbursement (add_reimbursement:
--   expense + 'Reimbursements payable' until it is paid).
--   Salary advances / staff loans (employee_loans) are a different thing and are not touched.
--
-- ══ WHAT THIS ADDS (no stored data is changed) ═══════════════════════════════════════════
--   1. employee_advance_bank_links — which bank line gave / topped up / returned an advance or
--      paid a reimbursement, and how much. Un-reconciling or deleting that line reverses exactly
--      that movement (trigger, section 4), so nothing drifts.
--   2. book_bank_txn_as_employee_advance(p_txn_id, p_kind, ...) — the bank page's choices:
--        'give'      money-out → a new advance: give_employee_advance (the Advances page's own
--                    RPC), then the line is linked to it (prepaid_advances.bank_txn_id).
--        'top_up'    money-out → top_up_employee_advance on the employee's open advance.
--        'return'    money-in  → the whole balance: settle_employee_advance (advance closed);
--                    part of it: the advance is reduced by that much and stays open (carried
--                    forward).
--        'reimburse' money-out → a pending reimbursement of exactly this amount is settled
--                    (settle_reimbursement) and the line is linked to its expense.
--      The line's account is passed as the account, so the existing cash-leg helper adds NO
--      petty-cash line (it only does that for a 'cash' account) — the bank line IS the money.
--      A Petty Cash account line is refused here: give / top up from Petty Cash on the Advances
--      page, which writes the cash line itself.
--   3. add_employee_advance_bills(p_advance_id, p_bills, p_reimburse_extra) — several bills
--      booked against the advance in one go (expenses with payment_method 'employee_advance';
--      the R-101 trigger moves consumed_amount). Bills more than the balance are refused unless
--      p_reimburse_extra: then the part over the balance goes through add_reimbursement.
--
-- §17c guard on both functions (no company → 28000; trusted = service_role or a direct DB
-- session). Money roles: bank choices owner / manager / accountant (the roles give / top-up /
-- settle already require); bills also billing (it records advance expenses today).
-- Proof: supabase/tests/r1871_employee_advance_bank.test.sql (one rollback).

begin;

-- ── 1. The link table ────────────────────────────────────────────────────────────────────
create table if not exists public.employee_advance_bank_links (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,
  bank_txn_id       uuid        not null unique references public.bank_transactions(id) on delete cascade,
  kind              text        not null check (kind in ('give', 'top_up', 'return', 'reimburse')),
  advance_id        uuid        references public.prepaid_advances(id) on delete cascade,
  reimbursement_id  uuid        references public.reimbursements(id) on delete cascade,
  amount            integer     not null check (amount > 0),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  check ((kind = 'reimburse') = (reimbursement_id is not null and advance_id is null))
);

comment on table public.employee_advance_bank_links is
  'R-1871: bank line ↔ employee office-expense advance movement (give / top-up / return) or reimbursement paid. Un-reconcile reverses it.';

create index if not exists employee_advance_bank_links_advance_idx
  on public.employee_advance_bank_links (tenant_id, advance_id);

alter table public.employee_advance_bank_links enable row level security;
drop policy if exists "tenant isolation read" on public.employee_advance_bank_links;
drop policy if exists zzz_service_role_all on public.employee_advance_bank_links;
create policy "tenant isolation read" on public.employee_advance_bank_links for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant', 'billing')));
create policy zzz_service_role_all on public.employee_advance_bank_links as permissive for all to service_role
  using (true) with check (true);
grant select on public.employee_advance_bank_links to authenticated;
grant select, insert, update, delete on public.employee_advance_bank_links to service_role;

-- ── 2. Bank line → advance / return / reimbursement ──────────────────────────────────────
create or replace function public.book_bank_txn_as_employee_advance(
  p_txn_id            uuid,
  p_kind              text,
  p_name              text default null,
  p_advance_id        uuid default null,
  p_reimbursement_id  uuid default null,
  p_note              text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_txn      public.bank_transactions;
  v_adv      public.prepaid_advances;
  v_reimb    public.reimbursements;
  v_id       uuid;
  v_amount   integer;
  v_left     integer;
  v_result   integer;
begin
  /* R-1871: §17c guard + the advance money roles (give / top-up / settle refuse anyone else). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can book an employee advance from the bank' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('give', 'top_up', 'return', 'reimburse') then
    raise exception 'Pick what this line is: advance given, top-up, advance returned or reimbursement.';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled — un-reconcile it first.'; end if;
  if exists (select 1 from public.bank_accounts where id = v_txn.bank_account_id and account_type = 'cash') then
    raise exception 'This is a Petty Cash line. Give or top up from Petty Cash on Accounting → Advances — it adds the cash line itself.';
  end if;

  if p_kind in ('give', 'top_up', 'reimburse') then
    v_amount := coalesce(v_txn.debit, 0);
    if v_amount <= 0 then raise exception 'Money given to an employee must be a money-out line.'; end if;
  else
    v_amount := coalesce(v_txn.credit, 0);
    if v_amount <= 0 then raise exception 'Money returned by an employee must be a money-in line.'; end if;
  end if;

  if p_kind = 'give' then
    if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Pick the employee who got the money.'; end if;
    -- The Advances page's own RPC. The line's account is a bank (not cash) → no extra cash line.
    v_id := public.give_employee_advance(trim(p_name), v_amount, v_txn.txn_date, 'bank_transfer', v_txn.bank_account_id,
                                         coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Office expenses'));
    update public.prepaid_advances set bank_txn_id = p_txn_id where id = v_id;
    v_result := v_amount;

  elsif p_kind in ('top_up', 'return') then
    select * into v_adv from public.prepaid_advances
     where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
    if not found then raise exception 'Pick the employee''s advance — that one is not in your company.'; end if;
    v_id := v_adv.id;

    if p_kind = 'top_up' then
      v_result := public.top_up_employee_advance(v_adv.id, v_amount, v_txn.txn_date, v_txn.bank_account_id);
    else
      if v_adv.closed_at is not null then raise exception 'The advance with % is already settled.', v_adv.vendor_name; end if;
      v_left := v_adv.total_amount - v_adv.consumed_amount;
      if v_amount > v_left then
        raise exception 'Only ₹% is still with %. A return of ₹% is more than that — book the extra as something else.', v_left, v_adv.vendor_name, v_amount;
      end if;
      if v_amount = v_left then
        -- The whole balance came back: the Advances page's Settle (advance closed).
        perform public.settle_employee_advance(v_adv.id, v_txn.txn_date, v_txn.bank_account_id);
        v_result := 0;
      else
        -- Part of it came back; the rest stays with the employee (carried forward).
        update public.prepaid_advances
           set total_amount = total_amount - v_amount, updated_at = now(),
               notes = concat_ws(E'\n', notes, 'Returned ₹' || v_amount || ' on ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
                                                || ' · ₹' || (v_left - v_amount) || ' still with them')
         where id = v_adv.id;
        v_result := v_left - v_amount;
      end if;
    end if;

  else -- reimburse
    select * into v_reimb from public.reimbursements
     where id = p_reimbursement_id and tenant_id = v_tenant for update;
    if not found then raise exception 'Pick the reimbursement — that one is not in your company.'; end if;
    if v_reimb.status <> 'pending' then raise exception 'That reimbursement is already paid.'; end if;
    if v_reimb.amount <> v_amount then
      raise exception 'The reimbursement is ₹% but this line is ₹%. Pick the matching one.', v_reimb.amount, v_amount;
    end if;
    perform public.settle_reimbursement(v_reimb.id, v_txn.txn_date, 'Paid by bank line ' || to_char(v_txn.txn_date, 'DD Mon YYYY'));
    v_result := 0;
  end if;

  update public.bank_transactions
     set matched_to_type  = case when p_kind = 'reimburse' then
                              case when v_reimb.expense_id is not null then 'expense' else 'manual' end
                            else 'prepaid' end,
         matched_to_id    = case when p_kind = 'reimburse' then coalesce(v_reimb.expense_id, 'reimbursement:' || v_reimb.id::text)
                            else v_id::text end,
         match_confidence = 'manual', matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;
  if p_kind = 'reimburse' and v_reimb.expense_id is not null then
    update public.expenses set reconciled_txn_id = p_txn_id where id = v_reimb.expense_id and tenant_id = v_tenant;
  end if;

  insert into public.employee_advance_bank_links (tenant_id, bank_txn_id, kind, advance_id, reimbursement_id, amount, created_by)
  values (v_tenant, p_txn_id, p_kind, case when p_kind = 'reimburse' then null else v_id end,
          case when p_kind = 'reimburse' then v_reimb.id end, v_amount, auth.uid());

  return jsonb_build_object('kind', p_kind, 'advance_id', case when p_kind = 'reimburse' then null else v_id end,
                            'reimbursement_id', case when p_kind = 'reimburse' then v_reimb.id end,
                            'amount', v_amount, 'left', v_result);
end;
$$;

revoke all on function public.book_bank_txn_as_employee_advance(uuid, text, text, uuid, uuid, text) from public, anon;
grant execute on function public.book_bank_txn_as_employee_advance(uuid, text, text, uuid, uuid, text) to authenticated, service_role;

-- ── 3. Bills against the advance ─────────────────────────────────────────────────────────
-- p_bills: [{date, vendor_name?, vendor_id?, category, amount (incl. GST), gst?, bill_no?,
--            attachment_url?, note?}]. Whole rupees. Booked in the order given; the bill that
-- crosses the balance is split (its GST pro rata) when p_reimburse_extra.
create or replace function public.add_employee_advance_bills(
  p_advance_id       uuid,
  p_bills            jsonb,
  p_reimburse_extra  boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted   boolean;
  v_tenant    uuid := public.current_tenant_id();
  v_state     text;
  v_adv       public.prepaid_advances;
  v_left      integer;
  v_total     bigint := 0;
  v_from_adv  integer := 0;
  v_extra     integer := 0;
  v_n         integer := 0;
  v_emp       uuid;
  v_reimb     uuid;
  v_reimbs    uuid[] := '{}';
  b           jsonb;
  v_date      date;
  v_cat       text;
  v_amt       integer;
  v_gst       integer;
  v_vendor    text;
  v_vid       uuid;
  v_gstin     text;
  v_part      integer;
  v_pgst      integer;
  v_exp       text;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can add bills to an advance' using errcode = '42501';
  end if;
  if p_bills is null or jsonb_typeof(p_bills) <> 'array' or jsonb_array_length(p_bills) = 0 then
    raise exception 'Add at least one bill.';
  end if;
  if jsonb_array_length(p_bills) > 50 then raise exception 'At most 50 bills at a time.'; end if;

  select * into v_adv from public.prepaid_advances
   where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
  if not found then raise exception 'Advance not found in your company.'; end if;
  if v_adv.closed_at is not null then
    raise exception 'The advance with % is settled. Give a new advance or a top-up first.', v_adv.vendor_name;
  end if;
  v_left := v_adv.total_amount - v_adv.consumed_amount;
  select state_code into v_state from public.tenants where id = v_tenant;

  -- Check every bill before writing any.
  for b in select * from jsonb_array_elements(p_bills) loop
    v_n := v_n + 1;
    if nullif(trim(coalesce(b->>'category', '')), '') is null then raise exception 'Bill %: pick a category.', v_n; end if;
    if b->>'category' = 'Salaries' then raise exception 'Bill %: salaries are paid through Payroll, not from an advance.', v_n; end if;
    if coalesce(b->>'amount', '') !~ '^\d{1,9}$' or (b->>'amount')::int <= 0 then
      raise exception 'Bill %: enter the bill amount in whole rupees.', v_n;
    end if;
    if coalesce(b->>'gst', '0') !~ '^\d{1,9}$' or coalesce((b->>'gst')::int, 0) >= (b->>'amount')::int then
      raise exception 'Bill %: GST must be whole rupees and less than the bill amount.', v_n;
    end if;
    begin
      v_date := (b->>'date')::date;
    exception when others then
      raise exception 'Bill %: enter the bill date.', v_n;
    end;
    if v_date is null then raise exception 'Bill %: enter the bill date.', v_n; end if;
    if nullif(b->>'vendor_id', '') is not null
       and not exists (select 1 from public.vendors where id = (b->>'vendor_id')::uuid and tenant_id = v_tenant) then
      raise exception 'Bill %: that vendor is not in your company.', v_n;
    end if;
    v_total := v_total + (b->>'amount')::int;
  end loop;

  if v_total > v_left and not coalesce(p_reimburse_extra, false) then
    raise exception 'Bills total ₹% but only ₹% is left with %. Tick "Reimburse ₹% to %" to book the extra as owed to them.',
      v_total, v_left, v_adv.vendor_name, v_total - v_left, v_adv.vendor_name using errcode = 'check_violation';
  end if;

  select id into v_emp from public.employees
   where tenant_id = v_tenant and lower(trim(name)) = lower(trim(v_adv.vendor_name))
   order by is_active desc nulls last limit 1;

  v_n := 0;
  for b in select * from jsonb_array_elements(p_bills) loop
    v_n := v_n + 1;
    v_date   := (b->>'date')::date;
    v_cat    := trim(b->>'category');
    v_amt    := (b->>'amount')::int;
    v_gst    := coalesce((b->>'gst')::int, 0);
    v_vendor := nullif(trim(coalesce(b->>'vendor_name', '')), '');
    v_vid    := nullif(b->>'vendor_id', '')::uuid;
    v_gstin  := null;
    if v_vid is not null then
      select gstin, coalesce(v_vendor, name) into v_gstin, v_vendor from public.vendors where id = v_vid;
    end if;

    -- From the advance: what still fits (the R-101 trigger moves consumed_amount and refuses
    -- more than what is left — the last word on the balance).
    v_part := least(v_amt, v_left);
    v_pgst := case when v_part = v_amt then v_gst else round(v_gst::numeric * v_part / v_amt)::int end;
    if v_part > 0 then
      v_exp := gen_random_uuid()::text;
      insert into public.expenses
        (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no,
         cgst, sgst, igst, payment_method, prepaid_advance_id, paid, paid_date, attachment_url, description, notes)
      values
        (v_exp, v_tenant, v_cat, v_vendor, v_vid, v_date, v_part, v_pgst,
         case when v_gst > 0 then 'gst' else 'kaccha' end, nullif(trim(coalesce(b->>'bill_no', '')), ''),
         case when v_pgst > 0 and v_gstin is not null and left(v_gstin, 2) = v_state then v_pgst - v_pgst / 2 end,
         case when v_pgst > 0 and v_gstin is not null and left(v_gstin, 2) = v_state then v_pgst / 2 end,
         case when v_pgst > 0 and v_gstin is not null and left(v_gstin, 2) <> v_state then v_pgst end,
         'employee_advance', v_adv.id, true, v_date, nullif(trim(coalesce(b->>'attachment_url', '')), ''),
         left('Paid by ' || v_adv.vendor_name || ' from advance', 500),
         nullif(left(trim(coalesce(b->>'note', '')), 1000), ''));
      v_left     := v_left - v_part;
      v_from_adv := v_from_adv + v_part;
    end if;

    -- The rest: the employee paid it from their own money → owed to them (reimbursement).
    if v_amt - v_part > 0 then
      v_reimb := public.add_reimbursement(v_adv.vendor_name,
                   'Office expenses over the advance' || coalesce(' · ' || v_vendor, ''),
                   v_cat, v_amt - v_part, v_gst - v_pgst, v_date, 'Own money (over the advance)', v_emp,
                   null);   -- the bill photo is in the bills bucket: it goes on the expense below, not
                            -- on receipt_path (which the Reimbursements page opens from employee-docs)
      -- The expense add_reimbursement wrote carries the real vendor + bill (for GST input credit).
      update public.expenses e
         set vendor_name = coalesce(v_vendor, e.vendor_name), vendor_id = v_vid,
             bill_type = case when v_gst > 0 then 'gst' else 'kaccha' end,
             bill_no = nullif(trim(coalesce(b->>'bill_no', '')), ''),
             attachment_url = nullif(trim(coalesce(b->>'attachment_url', '')), ''),
             cgst = case when (v_gst - v_pgst) > 0 and v_gstin is not null and left(v_gstin, 2) = v_state then (v_gst - v_pgst) - (v_gst - v_pgst) / 2 end,
             sgst = case when (v_gst - v_pgst) > 0 and v_gstin is not null and left(v_gstin, 2) = v_state then (v_gst - v_pgst) / 2 end,
             igst = case when (v_gst - v_pgst) > 0 and v_gstin is not null and left(v_gstin, 2) <> v_state then (v_gst - v_pgst) end,
             notes = nullif(left(trim(coalesce(b->>'note', '')), 1000), '')
        from public.reimbursements r
       where r.id = v_reimb and e.id = r.expense_id and e.tenant_id = v_tenant;
      v_reimbs := v_reimbs || v_reimb;
      v_extra  := v_extra + (v_amt - v_part);
    end if;
  end loop;

  return jsonb_build_object('bills', v_n, 'total', v_total, 'from_advance', v_from_adv,
                            'reimbursed', v_extra, 'reimbursement_ids', to_jsonb(v_reimbs),
                            'left', v_left, 'employee', v_adv.vendor_name);
end;
$$;

revoke all on function public.add_employee_advance_bills(uuid, jsonb, boolean) from public, anon;
grant execute on function public.add_employee_advance_bills(uuid, jsonb, boolean) to authenticated, service_role;

-- ── 4. Un-reconcile / delete of a linked line reverses its movement ───────────────────────
--   give      → reconcile_bank_txn already removes the advance (prepaid_advances.bank_txn_id)
--               and refuses when bills were booked against it; the link goes with it.
--   top_up    → the advance goes back down by the top-up; refused if bills already use it.
--   return    → the advance goes back up by the return and is open again.
--   reimburse → the reimbursement is pending again; its expense is no longer banked.
create or replace function public.tg_employee_advance_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.employee_advance_bank_links;
  v_adv  public.prepaid_advances;
begin
  if tg_op = 'UPDATE' and not (old.matched_to_type is not null
       and (new.matched_to_type is distinct from old.matched_to_type or new.matched_to_id is distinct from old.matched_to_id)) then
    return null;
  end if;
  select * into v_link from public.employee_advance_bank_links where bank_txn_id = old.id;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    return null;
  end if;

  if v_link.kind = 'top_up' then
    select * into v_adv from public.prepaid_advances where id = v_link.advance_id for update;
    if found then
      if v_adv.total_amount - v_link.amount < v_adv.consumed_amount then
        raise exception 'Bills of ₹% are already booked against % and the advance would go below that. Remove those bills first, then un-reconcile.',
          v_adv.consumed_amount, v_adv.vendor_name;
      end if;
      update public.prepaid_advances
         set total_amount = total_amount - v_link.amount, updated_at = now(),
             notes = concat_ws(E'\n', notes, 'Top-up ₹' || v_link.amount || ' undone (bank line un-reconciled)')
       where id = v_adv.id;
    end if;
  elsif v_link.kind = 'return' then
    update public.prepaid_advances
       set total_amount = total_amount + v_link.amount, closed_at = null, updated_at = now(),
           notes = concat_ws(E'\n', notes, 'Return ₹' || v_link.amount || ' undone (bank line un-reconciled)')
     where id = v_link.advance_id;
  elsif v_link.kind = 'reimburse' then
    update public.reimbursements set status = 'pending', settled_on = null, settled_notes = null
     where id = v_link.reimbursement_id;
    update public.expenses set reconciled_txn_id = null where reconciled_txn_id = old.id;
  end if;

  delete from public.employee_advance_bank_links where id = v_link.id;
  if tg_op = 'DELETE' then return old; end if;
  return null;
end;
$$;

revoke all on function public.tg_employee_advance_line_unmatched() from public, anon;

drop trigger if exists trg_employee_advance_line_unmatched on public.bank_transactions;
create trigger trg_employee_advance_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_employee_advance_line_unmatched();

drop trigger if exists trg_employee_advance_line_deleted on public.bank_transactions;
create trigger trg_employee_advance_line_deleted
  before delete on public.bank_transactions
  for each row execute function public.tg_employee_advance_line_unmatched();

commit;
