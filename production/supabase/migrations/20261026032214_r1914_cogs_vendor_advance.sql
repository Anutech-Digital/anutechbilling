-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendor_bills' and column_name = 'advance_applied') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendor_advance_applications' and column_name = 'vendor_bill_id') and to_regprocedure('public.vendor_advance_apply_bill_core(uuid,text,integer,date,uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.apply_vendor_advance(text,text,integer,date)') and prosrc like '%R-1914%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.undo_vendor_advance(text)') and prosrc like '%R-1914%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_debit_to_vendor(uuid,uuid,jsonb,jsonb,jsonb,integer,text,integer,text)') and prosrc like '%R-1914%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.consume_prepaid_fifo(text,integer,integer,date,text,text,uuid,text,integer,integer,integer,text,integer)') and prosrc like '%R-1914%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_vendor_payment_line_unmatched()') and prosrc like '%R-1914%')
-- deploy-key: r1914cogsvendoradvance
-- 20261026032214_r1914_cogs_vendor_advance.sql
--
-- R-1914 (26 Oct 2026, p1, goal G-RECON — R-1906 audit B4): a goods (COGS) vendor's advance
-- (Google, AWS) could never be set off against that vendor's COGS bill.
--
-- ─── THE BUG (proven, Anutech-HQ/drafts/R-1906/r1906_audit_proofs.sql) ───────────────────────
--   B4  An advance to Google Cloud India (default COGS-Workspace) was saved as prepaid category
--       'Other'; a COGS head was refused ("Pick the expense category…"); apply_vendor_advance
--       (R-1913) refused a COGS bill. So Google's next bill stayed payable, the advance sat on the
--       Balance Sheet for ever, and Prepaid → Book invoice booked it as opex, not COGS.
--
-- ─── THE FIX (extends the R-1913 path — same RPCs, same table) ──────────────────────────────
--   vendor_bills.advance_applied — the part of a COGS bill settled from the vendor's advances
--     (it is also inside paid_amount, so "still owed = total − paid_amount" is unchanged
--     everywhere: open items, Pay, payment runs, Balance Sheet payables, Vendors popup).
--   vendor_advance_applications.vendor_bill_id — an application is on an expense bill OR a COGS
--     bill (exactly one).
--   apply_vendor_advance('vendor_bill', id) → vendor_advance_apply_bill_core: FIFO from the
--     vendor's advances (same match as R-1913), paid_amount += applied, status partial / paid.
--     No expense row: the COGS bill is the cost, so P&L shows it under COGS.
--     194Q (buyer above ₹10 crore): the advance stops short of the 194Q TDS still due on the
--     bill (vendor_bill_194q_calc) — that part is deducted, not paid to the vendor.
--   undo_vendor_advance(id) — takes an expense id (as before) or a COGS bill id: advance back,
--     paid_amount less it, status unpaid / partial.
--   tg_vendor_bill_advance_applied_guard — a COGS bill's total cannot drop below its advance;
--     deleting the bill gives the advance back.
--   reconcile_bank_debit_to_vendor — an advance keeps the vendor's own head, COGS included
--     (only Salaries is refused); 'Other' only when the vendor has no head.
--   consume_prepaid_fifo (Prepaid → Book invoice) — refuses a COGS advance (it would become an
--     opex row) and says Bills → Apply advance.
--   tg_vendor_payment_line_unmatched — the "advance already used" sentence names Bills too.
--
-- Started from the LATEST definitions:
--   reconcile_bank_debit_to_vendor     20261026003327 (R-1918)
--   tg_vendor_payment_line_unmatched   20261025174159 (R-1915)
--   apply_vendor_advance, undo_vendor_advance, consume_prepaid_fifo  20261025164002 (R-1913)
-- Guards: §17c fail-closed tenant check, R-718 money roles (owner, manager, accountant, billing).
-- Stored data is not changed (advance_applied defaults to 0).
-- Test: supabase/tests/r1914_cogs_vendor_advance.test.sql

begin;

-- ── 1. The part of a COGS bill settled from advances ─────────────────────────────────────────
alter table public.vendor_bills add column if not exists advance_applied integer not null default 0;
alter table public.vendor_bills drop constraint if exists vendor_bills_advance_applied_check;
alter table public.vendor_bills add constraint vendor_bills_advance_applied_check check (advance_applied >= 0);
comment on column public.vendor_bills.advance_applied is
  'R-1914: the part of this COGS bill settled from the vendor''s advances (vendor_advance_applications). Already inside paid_amount; still owed = total − paid_amount.';

alter table public.vendor_advance_applications alter column expense_id drop not null;
alter table public.vendor_advance_applications add column if not exists vendor_bill_id text references public.vendor_bills(id);
alter table public.vendor_advance_applications drop constraint if exists vendor_advance_applications_one_doc_check;
alter table public.vendor_advance_applications add constraint vendor_advance_applications_one_doc_check
  check (num_nonnulls(expense_id, vendor_bill_id) = 1);
create index if not exists vendor_advance_applications_bill_idx on public.vendor_advance_applications (vendor_bill_id) where vendor_bill_id is not null;
comment on column public.vendor_advance_applications.vendor_bill_id is
  'R-1914: the COGS bill (vendor_bills) this advance was set off against — or expense_id for an expense bill, never both.';

-- ── 2. COGS bill edits: never below what the advance settled; delete gives the advance back ──
create or replace function public.tg_vendor_bill_advance_applied_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-1914 */
  if tg_op = 'DELETE' then
    if coalesce(old.advance_applied, 0) > 0 then
      update public.prepaid_advances pa
         set consumed_amount = greatest(0, pa.consumed_amount - a.amount), updated_at = now()
        from (select prepaid_advance_id, sum(amount) as amount from public.vendor_advance_applications
               where vendor_bill_id = old.id group by prepaid_advance_id) a
       where pa.id = a.prepaid_advance_id;
      delete from public.vendor_advance_applications where vendor_bill_id = old.id;
    end if;
    return old;
  end if;
  if coalesce(new.advance_applied, 0) > 0 and new.advance_applied > coalesce(new.total, 0) then
    raise exception 'Bill % has ₹% settled from the vendor''s advance — undo it first (Bills → the bill → Undo advance), then change the amount.',
      coalesce(new.bill_no, new.id), new.advance_applied using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_vendor_bill_advance_applied_guard() from public, anon;
drop trigger if exists trg_vendor_bill_advance_applied_guard on public.vendor_bills;
create trigger trg_vendor_bill_advance_applied_guard
  before update of total, advance_applied or delete on public.vendor_bills
  for each row execute function public.tg_vendor_bill_advance_applied_guard();

-- ── 3. Set an advance off against a COGS bill (internal, not callable) ──────────────────────
--   Same advance match and FIFO as vendor_advance_apply_core (R-1913). Caller checked tenant + role.
create or replace function public.vendor_advance_apply_bill_core(p_tenant uuid, p_bill_id text, p_amount integer, p_date date, p_uid uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill   public.vendor_bills;
  v_vendor public.vendors;
  v_name   text;
  v_owed   integer;
  v_tds    integer := 0;
  v_max    integer;
  v_avail  integer;
  v_want   integer;
  v_left   integer;
  v_take   integer;
  v_adv    record;
  v_run    text;
  v_status text;
  v_parts  jsonb := '[]'::jsonb;
begin
  /* R-1914 */
  select * into v_bill from public.vendor_bills where id = p_bill_id for update;
  if not found or v_bill.tenant_id is distinct from p_tenant then
    raise exception 'COGS bill % not found in your company', p_bill_id using errcode = '42501';
  end if;
  if upper(coalesce(v_bill.currency, 'INR')) <> 'INR' then
    raise exception 'Bill % is in % — an advance paid in rupees cannot be applied to it.', coalesce(v_bill.bill_no, v_bill.id), v_bill.currency
      using errcode = '22023';
  end if;
  v_owed := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
  if v_bill.status = 'paid' or v_owed <= 0 then
    raise exception 'Bill % is already paid — an advance can only be applied to a bill still to pay.', coalesce(v_bill.bill_no, v_bill.id)
      using errcode = 'check_violation';
  end if;
  select pr.run_no into v_run from public.payment_run_items pi join public.payment_runs pr on pr.id = pi.run_id
   where pi.tenant_id = p_tenant and pi.source = 'vendor_bill' and pi.doc_id = v_bill.id and pr.status in ('draft', 'approved') limit 1;
  if v_run is not null then
    raise exception 'Bill % is in payment run % — cancel that run first, then apply the advance.', coalesce(v_bill.bill_no, v_bill.id), v_run
      using errcode = 'check_violation';
  end if;
  if v_bill.vendor_id is not null then
    select * into v_vendor from public.vendors where id = v_bill.vendor_id and tenant_id = p_tenant;
  end if;
  v_name := coalesce(v_vendor.name, nullif(trim(coalesce(v_bill.vendor_name, '')), ''));
  if v_name is null then
    raise exception 'Bill % has no vendor — pick the vendor on the bill first.', coalesce(v_bill.bill_no, v_bill.id) using errcode = '22023';
  end if;

  /* 194Q: the TDS still due on this goods bill is deducted when it is paid — never settled from
     the advance (the vendor does not get that part). Same number the Banking step shows. */
  if coalesce((select t.tds_194q_buyer from public.tenants t where t.id = p_tenant), false) then
    select coalesce(q.tds_due, 0) into v_tds from public.vendor_bill_194q_calc(v_bill.id) q;
    v_tds := coalesce(v_tds, 0);
  end if;
  v_max := v_owed - v_tds;
  if v_max <= 0 then
    raise exception 'Only the 194Q TDS (₹%) is left on bill % — it is deducted, not paid from the advance.', v_tds, coalesce(v_bill.bill_no, v_bill.id)
      using errcode = 'check_violation';
  end if;

  perform 1 from public.prepaid_advances pa
   where pa.tenant_id = p_tenant and pa.closed_at is null and pa.category <> 'Employee advance'
     and pa.total_amount > pa.consumed_amount
     and (pa.vendor_id = v_vendor.id
          or ((pa.vendor_id is null or v_vendor.id is null) and upper(trim(pa.vendor_name)) = upper(v_name)))
   for update;
  select coalesce(sum(pa.total_amount - pa.consumed_amount), 0) into v_avail
    from public.prepaid_advances pa
   where pa.tenant_id = p_tenant and pa.closed_at is null and pa.category <> 'Employee advance'
     and pa.total_amount > pa.consumed_amount
     and (pa.vendor_id = v_vendor.id
          or ((pa.vendor_id is null or v_vendor.id is null) and upper(trim(pa.vendor_name)) = upper(v_name)));
  if v_avail <= 0 then
    raise exception 'No advance is left with %. Record the advance first (Banking → the payment line → Advance to vendor).', v_name
      using errcode = 'check_violation';
  end if;

  if p_amount is not null then
    if p_amount <= 0 then raise exception 'The advance to apply must be more than zero.' using errcode = '22023'; end if;
    if p_amount > v_max then
      if v_tds > 0 and p_amount <= v_owed then
        raise exception 'Bill % has ₹% of 194Q TDS still to deduct — apply at most ₹% of the advance; the TDS is deducted when the rest is paid.',
          coalesce(v_bill.bill_no, v_bill.id), v_tds, v_max using errcode = '22023';
      end if;
      raise exception 'Only ₹% is still to pay on bill % — apply at most that.', v_max, coalesce(v_bill.bill_no, v_bill.id) using errcode = '22023';
    end if;
    if p_amount > v_avail then
      raise exception 'Only ₹% of advance is left with % — apply at most that.', v_avail, v_name using errcode = '22023';
    end if;
  end if;
  v_want := coalesce(p_amount, least(v_max, v_avail));

  v_left := v_want;
  for v_adv in
    select pa.* from public.prepaid_advances pa
     where pa.tenant_id = p_tenant and pa.closed_at is null and pa.category <> 'Employee advance'
       and pa.total_amount > pa.consumed_amount
       and (pa.vendor_id = v_vendor.id
            or ((pa.vendor_id is null or v_vendor.id is null) and upper(trim(pa.vendor_name)) = upper(v_name)))
     order by pa.paid_date, pa.created_at, pa.id
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_adv.total_amount - v_adv.consumed_amount);
    update public.prepaid_advances
       set consumed_amount = consumed_amount + v_take, vendor_id = coalesce(vendor_id, v_vendor.id), updated_at = now()
     where id = v_adv.id;
    v_left := v_left - v_take;
    insert into public.vendor_advance_applications (tenant_id, prepaid_advance_id, vendor_bill_id, amount, applied_on, created_by)
    values (p_tenant, v_adv.id, v_bill.id, v_take, p_date, p_uid);
    v_parts := v_parts || jsonb_build_object('advance_id', v_adv.id, 'paid_date', v_adv.paid_date, 'amount', v_take);
  end loop;

  update public.vendor_bills
     set paid_amount = coalesce(paid_amount, 0) + v_want,
         advance_applied = coalesce(advance_applied, 0) + v_want,
         status = case when coalesce(paid_amount, 0) + v_want >= coalesce(total, 0) then 'paid' else 'partial' end,
         vendor_id = coalesce(vendor_id, v_vendor.id),
         updated_at = now()
   where id = v_bill.id
   returning status into v_status;

  return jsonb_build_object('source', 'vendor_bill', 'doc_id', v_bill.id, 'bill_no', v_bill.bill_no, 'vendor_name', v_name,
    'applied', v_want, 'still_due', v_owed - v_want, 'settled', v_status = 'paid', 'status', v_status,
    'tds_due', v_tds, 'advance_left', v_avail - v_want, 'parts', v_parts);
end;
$$;
revoke all on function public.vendor_advance_apply_bill_core(uuid, text, integer, date, uuid) from public, anon, authenticated;

-- ── 4. Apply / undo — the screens call these (§17b one transaction, §17c, R-718) ─────────────
create or replace function public.apply_vendor_advance(p_source text, p_doc_id text, p_amount integer default null, p_date date default public.ist_today())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_tenant  uuid;
begin
  /* R-1913: §17c fail-closed + R-718 money roles. R-1914: COGS bills (vendor_bills) too. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can apply a vendor advance' using errcode = '42501';
  end if;
  if p_source not in ('expense', 'vendor_bill') or p_source is null or p_doc_id is null then
    raise exception 'Pick the bill to apply the advance to.' using errcode = '22023';
  end if;
  if p_source = 'vendor_bill' then
    select tenant_id into v_tenant from public.vendor_bills where id = p_doc_id;
    if not found or (v_caller is not null and v_tenant is distinct from v_caller) then
      raise exception 'COGS bill % not found in your company', p_doc_id using errcode = '42501';
    end if;
    return public.vendor_advance_apply_bill_core(v_tenant, p_doc_id, p_amount, coalesce(p_date, public.ist_today()), public.current_user_id());
  end if;
  select tenant_id into v_tenant from public.expenses where id = p_doc_id;
  if not found or (v_caller is not null and v_tenant is distinct from v_caller) then
    raise exception 'Expense bill % not found in your company', p_doc_id using errcode = '42501';
  end if;
  return public.vendor_advance_apply_core(v_tenant, p_doc_id, p_amount, coalesce(p_date, public.ist_today()), public.current_user_id());
end;
$$;
revoke all on function public.apply_vendor_advance(text, text, integer, date) from public, anon;
grant execute on function public.apply_vendor_advance(text, text, integer, date) to authenticated, service_role;

create or replace function public.undo_vendor_advance(p_expense_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_exp     public.expenses;
  v_bill    public.vendor_bills;
  v_total   integer;
  v_prev    jsonb;
  v_paid    integer;
begin
  /* R-1913: §17c fail-closed + R-718 money roles.
     R-1914: p_expense_id may also be a COGS bill id (vendor_bills). */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can undo a vendor advance' using errcode = '42501';
  end if;
  select * into v_exp from public.expenses where id = p_expense_id for update;
  if not found then
    /* R-1914: a COGS bill — the advance comes back and leaves the bill's paid amount. */
    select * into v_bill from public.vendor_bills where id = p_expense_id for update;
    if not found or (v_caller is not null and v_bill.tenant_id is distinct from v_caller) then
      raise exception 'Bill % not found in your company', p_expense_id using errcode = '42501';
    end if;
    select coalesce(sum(amount), 0) into v_total from public.vendor_advance_applications where vendor_bill_id = v_bill.id;
    if v_total <= 0 then
      raise exception 'No advance is applied to bill %.', coalesce(v_bill.bill_no, v_bill.id) using errcode = 'check_violation';
    end if;
    update public.prepaid_advances pa
       set consumed_amount = greatest(0, pa.consumed_amount - a.amount), updated_at = now()
      from (select prepaid_advance_id, sum(amount) as amount from public.vendor_advance_applications
             where vendor_bill_id = v_bill.id group by prepaid_advance_id) a
     where pa.id = a.prepaid_advance_id;
    delete from public.vendor_advance_applications where vendor_bill_id = v_bill.id;
    v_paid := greatest(0, coalesce(v_bill.paid_amount, 0) - v_total);
    update public.vendor_bills
       set paid_amount = v_paid,
           advance_applied = 0,
           status = case when v_paid <= 0 then 'unpaid' when v_paid < coalesce(total, 0) then 'partial' else 'paid' end,
           updated_at = now()
     where id = v_bill.id;
    return jsonb_build_object('source', 'vendor_bill', 'doc_id', v_bill.id, 'bill_no', v_bill.bill_no, 'given_back', v_total,
                              'still_due', coalesce(v_bill.total, 0) - v_paid);
  end if;
  if v_caller is not null and v_exp.tenant_id is distinct from v_caller then
    raise exception 'Expense bill % not found in your company', p_expense_id using errcode = '42501';
  end if;
  select coalesce(sum(amount), 0) into v_total from public.vendor_advance_applications where expense_id = v_exp.id;
  if v_total <= 0 then
    raise exception 'No advance is applied to bill %.', coalesce(v_exp.bill_no, v_exp.id) using errcode = 'check_violation';
  end if;
  if v_exp.reconciled_txn_id is not null
     or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = v_exp.id) then
    raise exception 'The rest of bill % was paid from a bank line — un-reconcile that line first (Banking), then undo the advance.', coalesce(v_exp.bill_no, v_exp.id)
      using errcode = 'check_violation';
  end if;
  if v_exp.paid and coalesce(v_exp.payment_method, '') <> 'advance' then
    raise exception 'Bill % was marked paid after the advance — mark it unpaid first, then undo the advance.', coalesce(v_exp.bill_no, v_exp.id)
      using errcode = 'check_violation';
  end if;
  select a.prev into v_prev from public.vendor_advance_applications a
   where a.expense_id = v_exp.id and a.prev is not null order by a.created_at desc, a.id limit 1;

  update public.prepaid_advances pa
     set consumed_amount = greatest(0, pa.consumed_amount - a.amount), updated_at = now()
    from (select prepaid_advance_id, sum(amount) as amount from public.vendor_advance_applications
           where expense_id = v_exp.id group by prepaid_advance_id) a
   where pa.id = a.prepaid_advance_id;
  delete from public.vendor_advance_applications where expense_id = v_exp.id;
  update public.expenses
     set advance_applied = 0,
         paid = false,
         paid_date = case when v_exp.paid then (v_prev->>'paid_date')::date else paid_date end,
         payment_method = case when v_exp.paid then v_prev->>'payment_method' else payment_method end
   where id = v_exp.id;
  return jsonb_build_object('expense_id', v_exp.id, 'bill_no', v_exp.bill_no, 'given_back', v_total,
                            'still_due', v_exp.amount - coalesce(v_exp.tds_amount, 0));
end;
$$;
revoke all on function public.undo_vendor_advance(text) from public, anon;
grant execute on function public.undo_vendor_advance(text) to authenticated, service_role;

-- ── 5. Banking → "Paying a vendor?": an advance keeps the vendor's head, COGS included ──────
create or replace function public.reconcile_bank_debit_to_vendor(
  p_txn_id           uuid,
  p_vendor_id        uuid    default null,
  p_new_vendor       jsonb   default null,
  p_items            jsonb   default '[]'::jsonb,
  p_new_bill         jsonb   default null,
  p_advance          integer default 0,
  p_advance_category text    default null,
  p_bank_charge      integer default 0,
  p_note             text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted   boolean;
  v_caller    uuid;
  v_txn       public.bank_transactions;
  v_vendor    public.vendors;
  v_own_state text;
  v_v_state   text;
  v_cash      bigint := 0;
  it          jsonb;
  v_src       text; v_doc text; v_amt integer; v_tds integer; v_sec text;
  v_bill      public.vendor_bills;
  v_exp       public.expenses;
  v_out       integer;
  v_status    text;
  v_paid      jsonb := '[]'::jsonb;
  v_seen      text[] := '{}';
  v_run       text;
  v_new       jsonb := null;
  v_kind      text; v_cat text; v_taxable integer; v_gst integer; v_total integer; v_pay integer;
  v_itc       boolean; v_igst integer; v_cgst integer; v_sgst integer; v_id text; v_bdate date;
  v_adv_id    uuid;
  v_adv       jsonb := null;
  v_charge    jsonb := null;
  v_tds_total integer := 0;
  v_tds_sec   text := null;
  v_uid       uuid := public.current_user_id();
  v_name      text; v_gstin text; v_pan text;
  v_acc       text; v_ifsc text; v_upi text;   -- R-1918: the new vendor's bank details (from the bank line)
  v_q         record;   -- R-1891: vendor_bill_194q_calc of the bill
  v_qbase     integer := 0;
  v_syn       public.bank_transactions;   -- R-1911: the manual (Bills page / payment run) line being matched
  v_prev      jsonb;
  v_rec_paid  date;
  v_rec_where text;
  v_first     boolean;  -- R-1915: no bank part on the expense bill yet (its TDS goes with this one)
  v_gross_due integer;  -- R-1915: what this payment may settle on the expense bill (cash + TDS)
  v_new_paid  integer;
  v_new_tds   integer;
  v_left_due  integer;
begin
  /* §17c fail-closed + R-718 money roles. R-1915: an expense bill can be paid in parts.
     R-1914: an advance may carry a COGS head (the vendor's own by default). */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can pay a vendor from the bank' using errcode = '42501';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.debit, 0) <= 0 then
    raise exception 'Only a money-out (debit) bank line can pay a vendor.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;
  if coalesce(p_advance, 0) < 0 or coalesce(p_bank_charge, 0) < 0 then
    raise exception 'Advance and bank charge cannot be negative.' using errcode = '22023';
  end if;
  if (p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0)
     and p_new_bill is null and coalesce(p_advance, 0) = 0 then
    raise exception 'Pick the bill(s) this payment is for, a new bill, or an advance.' using errcode = '22023';
  end if;

  /* ── Vendor ── */
  if p_vendor_id is not null then
    select * into v_vendor from public.vendors where id = p_vendor_id for update;
    if not found or v_vendor.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Vendor not found in your company' using errcode = '42501';
    end if;
  else
    v_name  := nullif(trim(coalesce(p_new_vendor->>'name', '')), '');
    v_gstin := nullif(upper(trim(coalesce(p_new_vendor->>'gstin', ''))), '');
    v_pan   := nullif(upper(trim(coalesce(p_new_vendor->>'pan', ''))), '');
    if v_name is null then raise exception 'Pick the vendor, or type the new vendor''s name.' using errcode = '22023'; end if;
    if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
      raise exception 'GSTIN % does not look right (15 characters, e.g. 07AAACT1234F1Z5).', v_gstin using errcode = '22023';
    end if;
    if v_pan is null and v_gstin is not null then v_pan := substr(v_gstin, 3, 10); end if;
    /* R-1918: account no / IFSC / UPI id, pre-filled from the bank narration, are saved on the
       vendor so the next line from it is guessed (bank_debit_vendor_guess reads upi_id and
       bank_account_no). Same rules and words as lib/banking/bank-details.ts (R-1905). */
    v_acc  := nullif(regexp_replace(coalesce(p_new_vendor->>'bank_account_no', ''), '[[:space:]-]', '', 'g'), '');
    v_ifsc := nullif(upper(trim(coalesce(p_new_vendor->>'bank_ifsc', ''))), '');
    v_upi  := nullif(lower(trim(coalesce(p_new_vendor->>'upi_id', ''))), '');
    if v_acc is not null and v_acc !~ '^[0-9]{6,18}$' then
      raise exception 'The account number has digits only — 6 to 18 of them (got %).', v_acc using errcode = '22023';
    end if;
    if v_ifsc is not null and v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
      raise exception 'IFSC % does not look right — it needs 11 characters (4 letters, 0, then 6 letters/digits), e.g. HDFC0001234.', v_ifsc using errcode = '22023';
    end if;
    if v_ifsc is not null and v_acc is null then
      raise exception 'Add the account number that goes with this IFSC.' using errcode = '22023';
    end if;
    if v_upi is not null and v_upi !~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,64}$' then
      raise exception 'This UPI ID looks wrong — it is like name@okhdfcbank. Leave it empty if there is none.' using errcode = '22023';
    end if;
    select * into v_vendor from public.vendors
     where tenant_id = v_txn.tenant_id
       and ((v_gstin is not null and upper(gstin) = v_gstin) or upper(trim(name)) = upper(v_name))
     order by (v_gstin is not null and upper(gstin) = v_gstin) desc, created_at
     limit 1 for update;
    if not found then
      insert into public.vendors (tenant_id, name, gstin, pan, default_tds_section, bank_account_no, bank_ifsc, upi_id)
      values (v_txn.tenant_id, v_name, v_gstin, v_pan, nullif(upper(trim(coalesce(p_new_vendor->>'tds_section', ''))), ''),
              v_acc, v_ifsc, v_upi)
      returning * into v_vendor;
    elsif v_acc is not null or v_upi is not null then
      /* R-1918: the name / GSTIN is already a vendor — fill only what it has empty, never
         overwrite saved bank details. Account no and IFSC are one pair. */
      update public.vendors
         set bank_ifsc       = case when bank_account_no is null and v_acc is not null then v_ifsc else bank_ifsc end,
             bank_account_no = coalesce(bank_account_no, v_acc),
             upi_id          = coalesce(nullif(trim(upi_id), ''), v_upi)
       where id = v_vendor.id
      returning * into v_vendor;
    end if;
  end if;

  select coalesce(nullif(trim(t.state_code), ''), nullif(left(trim(coalesce(t.gstin, '')), 2), ''))
    into v_own_state from public.tenants t where t.id = v_txn.tenant_id;
  v_v_state := case when coalesce(v_vendor.gstin, '') ~ '^[0-9]{2}' then left(v_vendor.gstin, 2) end;

  /* ── (a) Open bills — R-1911: payments recorded outside the bank are matched FIRST, so a bill
         whose Bills-page payment this line replaces can then take the rest of the line ── */
  for it in select e.value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as e(value, n)
             order by (e.value->>'source' = 'recorded_payment') desc, e.n loop
    v_src := it->>'source';
    v_doc := it->>'doc_id';
    v_amt := round(coalesce((it->>'amount')::numeric, 0))::integer;
    v_tds := round(coalesce((it->>'tds_amount')::numeric, 0))::integer;
    v_sec := nullif(upper(trim(coalesce(it->>'tds_section', ''))), '');
    if v_src not in ('vendor_bill', 'expense', 'recorded_payment') or v_doc is null then raise exception 'Bad bill in the list' using errcode = '22023'; end if;
    if v_src || ':' || v_doc = any (v_seen) then raise exception '% is in the list twice', v_doc using errcode = '22023'; end if;
    v_seen := v_seen || (v_src || ':' || v_doc);
    if v_amt <= 0 then raise exception 'Amount for % must be more than zero', v_doc using errcode = '22023'; end if;
    if v_tds < 0 then raise exception 'TDS cannot be negative' using errcode = '22023'; end if;

    /* ── R-1911: MATCH a payment already recorded (Bills page / payment run / Mark paid) — this
           bank line takes its place; nothing is paid again. ── */
    if v_src = 'recorded_payment' then
      if v_tds <> 0 then
        raise exception 'A payment already recorded keeps its own TDS — match it without TDS.' using errcode = '22023';
      end if;
      v_syn := null;
      if v_doc ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select * into v_syn from public.bank_transactions where id = v_doc::uuid for update;
      end if;
      if v_syn.id is not null then
        -- (1) A manual bank line (Bills page Pay / payment run) — deleted, this line stands for it.
        if v_syn.tenant_id is distinct from v_txn.tenant_id or v_syn.source <> 'manual'
           or v_syn.matched_to_type not in ('vendor_bill', 'expense') or coalesce(v_syn.debit, 0) <= 0 then
          raise exception 'That recorded payment is not a Bills-page payment of your company — refresh and pick again.' using errcode = '42501';
        end if;
        if v_syn.matched_to_type = 'vendor_bill' then
          select * into v_bill from public.vendor_bills where id = v_syn.matched_to_id for update;
          if not found or v_bill.tenant_id is distinct from v_txn.tenant_id then
            raise exception 'The bill of that recorded payment was not found' using errcode = '42501';
          end if;
          if not coalesce(v_bill.vendor_id = v_vendor.id or (v_bill.vendor_id is null and upper(trim(v_bill.vendor_name)) = upper(trim(v_vendor.name))), false) then
            raise exception 'The payment recorded on % is for bill % of %, not %', v_syn.txn_date, coalesce(v_bill.bill_no, v_bill.id), v_bill.vendor_name, v_vendor.name using errcode = '22023';
          end if;
          if coalesce(v_bill.paid_amount, 0) > coalesce(v_bill.total, 0) then
            raise exception 'Bill % shows ₹% paid on a ₹% bill — fix the bill before matching.', coalesce(v_bill.bill_no, v_bill.id), v_bill.paid_amount, v_bill.total using errcode = 'check_violation';
          end if;
        else
          select * into v_exp from public.expenses where id = v_syn.matched_to_id for update;
          if not found or v_exp.tenant_id is distinct from v_txn.tenant_id then
            raise exception 'The expense of that recorded payment was not found' using errcode = '42501';
          end if;
          if not coalesce(v_exp.vendor_id = v_vendor.id or (v_exp.vendor_id is null and upper(trim(coalesce(v_exp.vendor_name, ''))) = upper(trim(v_vendor.name))), false) then
            raise exception 'The payment recorded on % is for % of %, not %', v_syn.txn_date, coalesce(v_exp.bill_no, v_exp.id), coalesce(v_exp.vendor_name, 'another vendor'), v_vendor.name using errcode = '22023';
          end if;
        end if;
        if v_amt <> v_syn.debit then
          raise exception 'The payment recorded on % was ₹% — match all of it (not ₹%), and put the rest of this line elsewhere.', v_syn.txn_date, v_syn.debit, v_amt
            using errcode = '22023';
        end if;
        v_prev := jsonb_build_object('synthetic', to_jsonb(v_syn),
                    'expense', case when v_syn.matched_to_type = 'expense' then jsonb_build_object(
                                 'reconciled_txn_id', v_exp.reconciled_txn_id, 'paid_date', v_exp.paid_date,
                                 'payment_method', v_exp.payment_method, 'bank_account_id', v_exp.bank_account_id) end);
        delete from public.bank_transactions where id = v_syn.id;
        if v_syn.matched_to_type = 'vendor_bill' then
          insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash, prev, created_by)
          values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'recorded_payment', v_bill.id, v_amt, v_prev, v_uid);
          v_paid := v_paid || jsonb_build_object('source', 'recorded_payment', 'pays_source', 'vendor_bill', 'doc_id', v_bill.id, 'bill_no', v_bill.bill_no,
                     'settled', v_amt, 'cash', v_amt, 'tds', 0, 'tds_section', null, 'status', v_bill.status,
                     'still_due', greatest(0, coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0)), 'paid_on', v_syn.txn_date);
        else
          update public.expenses
             set reconciled_txn_id = p_txn_id, bank_account_id = v_txn.bank_account_id, paid_date = v_txn.txn_date
           where id = v_exp.id;
          insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, prev, created_by)
          values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'recorded_payment', v_exp.id, v_amt, v_prev, v_uid);
          v_paid := v_paid || jsonb_build_object('source', 'recorded_payment', 'pays_source', 'expense', 'doc_id', v_exp.id, 'bill_no', v_exp.bill_no,
                     'settled', v_amt, 'cash', v_amt, 'tds', 0, 'tds_section', null, 'status', 'paid', 'still_due', 0, 'paid_on', v_syn.txn_date);
        end if;
      else
        -- (2) An expense marked paid with no bank line (Expenses → Mark paid) — now banked by this line.
        select * into v_exp from public.expenses where id = v_doc for update;
        if not found or v_exp.tenant_id is distinct from v_txn.tenant_id then
          raise exception 'That recorded payment was not found in your company — refresh and pick again.' using errcode = '42501';
        end if;
        if not coalesce(v_exp.vendor_id = v_vendor.id or (v_exp.vendor_id is null and upper(trim(coalesce(v_exp.vendor_name, ''))) = upper(trim(v_vendor.name))), false) then
          raise exception 'Expense % is from %, not %', coalesce(v_exp.bill_no, v_doc), coalesce(v_exp.vendor_name, 'another vendor'), v_vendor.name using errcode = '22023';
        end if;
        if not v_exp.paid or v_exp.reconciled_txn_id is not null
           or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = v_exp.id and l.kind = 'recorded_payment') then
          raise exception 'Expense % is not a payment waiting for its bank line (unpaid, or already matched).', coalesce(v_exp.bill_no, v_doc) using errcode = 'check_violation';
        end if;
        if upper(coalesce(v_exp.currency, 'INR')) <> 'INR' or v_exp.prepaid_advance_id is not null or v_exp.category = 'Salaries'
           or lower(coalesce(v_exp.payment_method, '')) in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance') then
          raise exception 'Expense % was not paid from a bank — it cannot be matched to a bank line.', coalesce(v_exp.bill_no, v_doc) using errcode = '22023';
        end if;
        -- R-1913: the part settled from the vendor's advance never went through a bank.
        -- R-1915: nor did the bank parts already reconciled on it — the Mark paid recorded the rest.
        if v_amt <> v_exp.amount - coalesce(v_exp.tds_amount, 0) - coalesce(v_exp.advance_applied, 0) - coalesce(v_exp.paid_amount, 0) then
          raise exception 'Expense % was paid ₹% outside the bank feed (₹% less TDS ₹%, advance applied ₹% and bank parts ₹%) — match all of it, not ₹%.', coalesce(v_exp.bill_no, v_doc),
            v_exp.amount - coalesce(v_exp.tds_amount, 0) - coalesce(v_exp.advance_applied, 0) - coalesce(v_exp.paid_amount, 0), v_exp.amount, coalesce(v_exp.tds_amount, 0),
            coalesce(v_exp.advance_applied, 0), coalesce(v_exp.paid_amount, 0), v_amt using errcode = '22023';
        end if;
        v_prev := jsonb_build_object('synthetic', null, 'expense', jsonb_build_object(
                    'reconciled_txn_id', null, 'paid_date', v_exp.paid_date,
                    'payment_method', v_exp.payment_method, 'bank_account_id', v_exp.bank_account_id));
        update public.expenses
           set reconciled_txn_id = p_txn_id, bank_account_id = v_txn.bank_account_id, paid_date = v_txn.txn_date,
               payment_method = 'bank'
         where id = v_exp.id;
        insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, prev, created_by)
        values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'recorded_payment', v_exp.id, v_amt, v_prev, v_uid);
        v_paid := v_paid || jsonb_build_object('source', 'recorded_payment', 'pays_source', 'expense', 'doc_id', v_exp.id, 'bill_no', v_exp.bill_no,
                   'settled', v_amt, 'cash', v_amt, 'tds', 0, 'tds_section', null, 'status', 'paid', 'still_due', 0,
                   'paid_on', coalesce(v_exp.paid_date, v_exp.expense_date));
      end if;
      v_cash := v_cash + v_amt;
      continue;
    end if;

    select pr.run_no into v_run from public.payment_run_items pi join public.payment_runs pr on pr.id = pi.run_id
     where pi.tenant_id = v_txn.tenant_id and pi.source = v_src and pi.doc_id = v_doc and pr.status in ('draft', 'approved') limit 1;
    if v_run is not null then
      raise exception '% is in payment run % — mark that run paid, or cancel it, instead.', v_doc, v_run using errcode = 'check_violation';
    end if;

    if v_src = 'vendor_bill' then
      select * into v_bill from public.vendor_bills where id = v_doc for update;
      if not found or v_bill.tenant_id is distinct from v_txn.tenant_id then
        raise exception 'Bill % not found in your company', v_doc using errcode = '42501';
      end if;
      if not coalesce(v_bill.vendor_id = v_vendor.id or (v_bill.vendor_id is null and upper(trim(v_bill.vendor_name)) = upper(trim(v_vendor.name))), false) then
        raise exception 'Bill % is from %, not %', coalesce(v_bill.bill_no, v_doc), v_bill.vendor_name, v_vendor.name using errcode = '22023';
      end if;
      if upper(coalesce(v_bill.currency, 'INR')) <> 'INR' then
        raise exception 'Bill % is in %, pay it from the Bills page', coalesce(v_bill.bill_no, v_doc), v_bill.currency using errcode = '22023';
      end if;
      /* R-1911: a payment of this amount already recorded on this bill with no real bank line
         (Bills page Pay / payment run) IS this money — paying the bill again pays the vendor twice. */
      select t.txn_date into v_rec_paid from public.bank_transactions t
       where t.tenant_id = v_txn.tenant_id and t.source = 'manual' and t.matched_to_type = 'vendor_bill'
         and t.matched_to_id = v_doc and t.debit in (v_amt, v_amt - v_tds, v_txn.debit)
       order by abs(t.txn_date - v_txn.txn_date) limit 1;
      if found then
        raise exception 'Bill % already has this payment recorded on % from the Bills page, with no bank line yet — match this bank line to that payment (it would pay the vendor twice).',
          coalesce(v_bill.bill_no, v_doc), to_char(v_rec_paid, 'DD Mon YYYY') using errcode = 'check_violation';
      end if;
      /* R-1891: TDS on a goods bill is 194Q only, only for a buyer above ₹10 crore, and exactly
         the TDS still due on it (vendor_bill_194q_calc — the number the screen shows). */
      v_qbase := 0;
      if v_tds > 0 then
        if coalesce(v_sec, '194Q') <> '194Q' then
          raise exception 'TDS on a COGS (goods) bill is 194Q only — % is for services. Record that bill as an expense bill to deduct %.', v_sec, v_sec
            using errcode = '22023';
        end if;
        v_sec := '194Q';
        if not coalesce((select t.tds_194q_buyer from public.tenants t where t.id = v_txn.tenant_id), false) then
          raise exception '194Q TDS applies only when your business turnover last financial year was above ₹10 crore — answer that question first.'
            using errcode = '22023';
        end if;
        select * into v_q from public.vendor_bill_194q_calc(v_doc);
        if coalesce(v_q.tds_due, 0) = 0 then
          raise exception 'No 194Q TDS is due on bill %: % this year before it, so nothing of it is above ₹50 lakh — or its TDS was already deducted (₹%).',
            coalesce(v_bill.bill_no, v_doc), '₹' || coalesce(v_q.fy_before, 0), coalesce(v_q.tds_already, 0)
            using errcode = '22023';
        end if;
        if v_tds <> v_q.tds_due then
          raise exception '194Q TDS on bill % is ₹% (% of ₹% above ₹50 lakh), not ₹%.',
            coalesce(v_bill.bill_no, v_doc), v_q.tds_due, v_q.rate_pct || '%', v_q.base, v_tds
            using errcode = '22023';
        end if;
        if v_tds >= v_amt then
          raise exception 'Bill %: the TDS ₹% must be less than the amount settled ₹%.', coalesce(v_bill.bill_no, v_doc), v_tds, v_amt using errcode = '22023';
        end if;
        v_qbase := v_q.base;
      end if;
      v_out := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
      if v_bill.status = 'paid' or v_out <= 0 then raise exception 'Bill % is already paid', coalesce(v_bill.bill_no, v_doc) using errcode = 'check_violation'; end if;
      if v_amt > v_out then
        raise exception 'Bill %: ₹% is more than the ₹% still owed — put the extra as an advance.', coalesce(v_bill.bill_no, v_doc), v_amt, v_out using errcode = '22023';
      end if;
      -- Same settlement as pay_vendor_bill / mark_payment_run_paid; the TDS is part of paying the bill.
      update public.vendor_bills
         set paid_amount = coalesce(paid_amount, 0) + v_amt,
             status = case when coalesce(paid_amount, 0) + v_amt >= coalesce(total, 0) then 'paid' else 'partial' end,
             updated_at = now()
       where id = v_doc
       returning status into v_status;
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash,
                                                    tds_amount, tds_section, tds_base, tds_on, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'bill', v_doc, v_amt - v_tds,
              v_tds, case when v_tds > 0 then v_sec end, v_qbase,
              case when v_tds > 0 then v_txn.txn_date end, v_uid);
      v_cash := v_cash + (v_amt - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      v_paid := v_paid || jsonb_build_object('source', 'vendor_bill', 'doc_id', v_doc, 'bill_no', v_bill.bill_no,
                 'settled', v_amt, 'cash', v_amt - v_tds, 'tds', v_tds, 'tds_section', case when v_tds > 0 then v_sec end,
                 'status', v_status, 'still_due', v_out - v_amt);
    else
      select * into v_exp from public.expenses where id = v_doc for update;
      if not found or v_exp.tenant_id is distinct from v_txn.tenant_id then
        raise exception 'Expense bill % not found in your company', v_doc using errcode = '42501';
      end if;
      if not coalesce(v_exp.vendor_id = v_vendor.id or (v_exp.vendor_id is null and upper(trim(coalesce(v_exp.vendor_name, ''))) = upper(trim(v_vendor.name))), false) then
        raise exception 'Expense bill % is from %, not %', coalesce(v_exp.bill_no, v_doc), coalesce(v_exp.vendor_name, 'another vendor'), v_vendor.name using errcode = '22023';
      end if;
      if v_exp.paid or v_exp.reconciled_txn_id is not null then
        raise exception 'Expense bill % is already paid', coalesce(v_exp.bill_no, v_doc) using errcode = 'check_violation';
      end if;
      if upper(coalesce(v_exp.currency, 'INR')) <> 'INR' or coalesce(v_exp.payment_method, '') in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
         or v_exp.prepaid_advance_id is not null or v_exp.category = 'Salaries' then
        raise exception 'Expense % is not a vendor bill that can be paid here', v_doc using errcode = '22023';
      end if;
      /* R-1913: the vendor's advance applied to it is not paid again.
         R-1915: part payments. The bill's whole TDS is withheld with its FIRST bank part (TDS is
         due at credit or payment, whichever is earlier); later parts carry none. */
      v_first := coalesce(v_exp.paid_amount, 0) = 0;
      v_gross_due := v_exp.amount - coalesce(v_exp.advance_applied, 0) - coalesce(v_exp.paid_amount, 0)
                     - case when v_first then 0 else coalesce(v_exp.tds_amount, 0) end;
      if v_gross_due <= 0 then
        raise exception 'Nothing is left to pay on expense bill %.', coalesce(v_exp.bill_no, v_doc) using errcode = 'check_violation';
      end if;
      if not v_first and v_tds > 0 then
        raise exception 'TDS on bill % was taken with its first payment (₹%) — pay the rest (₹%) without TDS.', coalesce(v_exp.bill_no, v_doc),
          coalesce(v_exp.tds_amount, 0), v_gross_due using errcode = '22023';
      end if;
      if v_amt > v_gross_due then
        if coalesce(v_exp.advance_applied, 0) > 0 then
          raise exception 'Expense bill % has ₹% left to pay after the advance applied (₹%) — ₹% is more than that; put the extra as an advance.', coalesce(v_exp.bill_no, v_doc),
            v_gross_due, v_exp.advance_applied, v_amt using errcode = '22023';
        end if;
        raise exception 'Expense bill %: ₹% is more than the ₹% still to pay — put the extra as an advance.', coalesce(v_exp.bill_no, v_doc), v_amt, v_gross_due
          using errcode = '22023';
      end if;
      if v_tds > v_amt or (v_tds > 0 and v_tds >= v_amt and v_amt < v_gross_due) then
        raise exception 'TDS ₹% must be less than the ₹% this payment settles on bill %.', v_tds, v_amt, coalesce(v_exp.bill_no, v_doc) using errcode = '22023';
      end if;
      if v_first and coalesce(v_exp.tds_amount, 0) > 0 and v_tds <> v_exp.tds_amount then
        raise exception 'Expense bill % already has ₹% TDS recorded — the payment must use the same TDS.', coalesce(v_exp.bill_no, v_doc), v_exp.tds_amount
          using errcode = '22023';
      end if;
      if v_tds > greatest(0, v_exp.amount - coalesce(v_exp.gst_paid, 0)) then
        raise exception 'TDS ₹% cannot be more than the value before GST (₹%).', v_tds, greatest(0, v_exp.amount - coalesce(v_exp.gst_paid, 0)) using errcode = '22023';
      end if;
      v_sec := case when v_tds > 0 then coalesce(v_sec, nullif(upper(trim(coalesce(v_exp.tds_section, ''))), '')) end;
      if v_tds > 0 and v_sec is null then raise exception 'Pick the TDS section for ₹% of TDS.', v_tds using errcode = '22023'; end if;

      v_new_tds  := case when v_first then v_tds else coalesce(v_exp.tds_amount, 0) end;
      v_new_paid := coalesce(v_exp.paid_amount, 0) + (v_amt - v_tds);
      v_left_due := v_exp.amount - v_new_tds - coalesce(v_exp.advance_applied, 0) - v_new_paid;

      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, tds_amount, tds_section, prev, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'expense', v_doc, v_amt - v_tds, v_tds, v_sec,
              jsonb_build_object('tds_amount', v_exp.tds_amount, 'tds_section', v_exp.tds_section, 'paid_date', v_exp.paid_date,
                                 'payment_method', v_exp.payment_method, 'bank_account_id', v_exp.bank_account_id, 'vendor_id', v_exp.vendor_id,
                                 'paid_amount', coalesce(v_exp.paid_amount, 0)),
              v_uid);
      if v_left_due <= 0 then
        -- The last rupee: the bill is paid, and this line is its bank match.
        update public.expenses
           set paid = true, paid_date = v_txn.txn_date, payment_method = 'bank',
               bank_account_id = v_txn.bank_account_id, reconciled_txn_id = p_txn_id,
               vendor_id = coalesce(vendor_id, v_vendor.id), paid_amount = v_new_paid,
               tds_amount = v_new_tds, tds_section = case when v_tds > 0 then v_sec else tds_section end
         where id = v_doc;
        v_status := 'paid';
      else
        -- A part: the bill stays to pay (partial), with v_left_due still owed.
        update public.expenses
           set vendor_id = coalesce(vendor_id, v_vendor.id), paid_amount = v_new_paid,
               tds_amount = v_new_tds, tds_section = case when v_tds > 0 then v_sec else tds_section end
         where id = v_doc;
        v_status := 'partial';
      end if;
      v_cash := v_cash + (v_amt - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      v_paid := v_paid || jsonb_build_object('source', 'expense', 'doc_id', v_doc, 'bill_no', v_exp.bill_no,
                 'settled', v_amt, 'cash', v_amt - v_tds, 'tds', v_tds, 'tds_section', v_sec, 'status', v_status,
                 'still_due', greatest(0, v_left_due));
    end if;
  end loop;

  /* ── (b) New bill on the spot ── */
  if p_new_bill is not null then
    v_kind    := p_new_bill->>'kind';
    v_cat     := nullif(trim(coalesce(p_new_bill->>'category', '')), '');
    v_taxable := round(coalesce((p_new_bill->>'taxable')::numeric, 0))::integer;
    v_gst     := round(coalesce((p_new_bill->>'gst')::numeric, 0))::integer;
    v_itc     := coalesce((p_new_bill->>'itc')::boolean, true);
    v_tds     := round(coalesce((p_new_bill->>'tds_amount')::numeric, 0))::integer;
    v_sec     := nullif(upper(trim(coalesce(p_new_bill->>'tds_section', ''))), '');
    v_bdate   := coalesce((p_new_bill->>'bill_date')::date, v_txn.txn_date);
    v_total   := v_taxable + v_gst;
    v_pay     := round(coalesce((p_new_bill->>'pay')::numeric, v_total))::integer;
    if v_kind not in ('cogs', 'expense') then raise exception 'New bill: pick COGS bill or expense' using errcode = '22023'; end if;
    if v_taxable <= 0 or v_gst < 0 then raise exception 'New bill: the value before GST must be more than zero.' using errcode = '22023'; end if;
    if v_tds < 0 or v_tds > v_taxable then raise exception 'New bill: TDS ₹% cannot be more than the value before GST (₹%).', v_tds, v_taxable using errcode = '22023'; end if;
    if v_tds > 0 and v_sec is null then raise exception 'New bill: pick the TDS section for ₹% of TDS.', v_tds using errcode = '22023'; end if;
    if v_pay <= 0 or v_pay > v_total then raise exception 'New bill: pay ₹% must be between ₹1 and the bill total ₹%.', v_pay, v_total using errcode = '22023'; end if;
    if v_own_state is not null and v_v_state is not null and v_own_state <> v_v_state then
      v_igst := v_gst; v_cgst := 0; v_sgst := 0;
    else
      v_igst := 0; v_cgst := v_gst / 2; v_sgst := v_gst - v_gst / 2;
    end if;

    if v_kind = 'cogs' then
      if v_cat is null or v_cat not like 'COGS-%' then raise exception 'New COGS bill: pick a COGS category.' using errcode = '22023'; end if;
      if v_tds > 0 then
        -- R-1891: 194Q is worked out on a saved bill (its place in the year's purchases).
        raise exception 'TDS on a COGS bill typed here cannot be taken — record the bill first (Bills → Record a bill), then pay it here: the 194Q TDS is worked out on the saved bill.' using errcode = '22023';
      end if;
      v_id := 'BILL-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
      insert into public.vendor_bills
        (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category,
         subtotal, cgst, sgst, igst, total, status, paid_amount, notes, document_type, currency, fx_rate)
      values
        (v_id, v_txn.tenant_id, v_vendor.id, v_vendor.name, v_vendor.gstin,
         nullif(trim(coalesce(p_new_bill->>'bill_no', '')), ''), v_bdate,
         coalesce((p_new_bill->>'due_date')::date, v_bdate), v_cat,
         v_taxable, v_cgst, v_sgst, v_igst, v_total,
         case when v_pay >= v_total then 'paid' else 'partial' end, v_pay,
         coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Recorded from a bank payment'),
         case when v_itc and v_gst > 0 then 'tax_invoice' else 'other' end, 'INR', 1);
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'new_bill', v_id, v_pay, v_uid);
      v_cash := v_cash + v_pay;
      v_new := jsonb_build_object('source', 'vendor_bill', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no', 'total', v_total,
                 'settled', v_pay, 'cash', v_pay, 'tds', 0, 'status', case when v_pay >= v_total then 'paid' else 'partial' end,
                 'still_due', v_total - v_pay);
    else
      if v_cat is null or v_cat like 'COGS-%' or v_cat = 'Salaries' then
        raise exception 'New expense bill: pick an expense category (Salaries go through Payroll).' using errcode = '22023';
      end if;
      if v_pay <> v_total then
        raise exception 'A new expense bill is paid in full (₹%). For a part payment, record the bill first and book the money as an advance.', v_total
          using errcode = '22023';
      end if;
      v_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
      insert into public.expenses
        (id, tenant_id, category, vendor_name, vendor_id, expense_date, due_date, amount, gst_paid, igst, cgst, sgst,
         bill_type, bill_no, payment_method, description, paid, paid_date, bank_account_id, reconciled_txn_id,
         tds_section, tds_amount)
      values
        (v_id, v_txn.tenant_id, v_cat, v_vendor.name, v_vendor.id, v_bdate, coalesce((p_new_bill->>'due_date')::date, v_bdate),
         v_total, v_gst, v_igst, v_cgst, v_sgst,
         case when v_itc and v_gst > 0 then 'gst' else 'none' end,
         nullif(trim(coalesce(p_new_bill->>'bill_no', '')), ''), 'bank',
         coalesce(nullif(trim(coalesce(p_note, '')), ''), v_txn.description),
         true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id,
         case when v_tds > 0 then v_sec end, v_tds);
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, tds_amount, tds_section, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'new_expense', v_id, v_total - v_tds, v_tds, case when v_tds > 0 then v_sec end, v_uid);
      v_cash := v_cash + (v_total - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      v_new := jsonb_build_object('source', 'expense', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no', 'total', v_total,
                 'settled', v_total, 'cash', v_total - v_tds, 'tds', v_tds, 'tds_section', case when v_tds > 0 then v_sec end,
                 'status', 'paid', 'still_due', 0);
    end if;
  end if;

  /* ── (c) Advance / extra ── */
  if coalesce(p_advance, 0) > 0 then
    /* R-1911: the whole line as an advance while this vendor has a payment of exactly this amount
       recorded outside the bank (±30 days) and not matched — that is the same money, not an advance. */
    if p_advance = v_txn.debit then
      select o.paid_on, case o.pays_source when 'expense' then 'on the Expenses page' else 'on the Bills page' end
        into v_rec_paid, v_rec_where
        from public.bank_debit_vendor_open_items(v_vendor.id) o
       where o.source = 'recorded_payment' and o.amount_due = v_txn.debit and abs(o.paid_on - v_txn.txn_date) <= 30
       order by abs(o.paid_on - v_txn.txn_date) limit 1;
      if found then
        raise exception '₹% to % is already recorded as paid on % %, with no bank line yet — match this bank line to that payment instead of keeping it as an advance (the money would go out twice).',
          v_txn.debit, v_vendor.name, to_char(v_rec_paid, 'DD Mon YYYY'), v_rec_where using errcode = 'check_violation';
      end if;
    end if;
    /* R-1914: an advance to a goods (COGS) vendor keeps the vendor's COGS head — it is set off
       later against that vendor's COGS bill (Bills → Apply advance), never booked as opex. */
    v_cat := coalesce(nullif(trim(coalesce(p_advance_category, '')), ''),
                      nullif(trim(coalesce(v_vendor.default_category, '')), ''),
                      'Other');
    if v_cat = 'Salaries' then
      raise exception 'Pick the expense or COGS head the advance will be used for (Salaries go through Payroll).' using errcode = '22023';
    end if;
    insert into public.prepaid_advances
      (tenant_id, vendor_name, vendor_id, category, total_amount, consumed_amount, paid_date, payment_method,
       bank_account_id, notes, created_by)
    values
      (v_txn.tenant_id, v_vendor.name, v_vendor.id, v_cat, p_advance, 0, v_txn.txn_date, 'bank_transfer',
       v_txn.bank_account_id, coalesce(nullif(trim(coalesce(p_note, '')), ''), v_txn.description), v_uid)
    returning id into v_adv_id;
    insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, prepaid_advance_id, cash, created_by)
    values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'advance', v_adv_id, p_advance, v_uid);
    v_cash := v_cash + p_advance;
    v_adv := jsonb_build_object('id', v_adv_id, 'amount', p_advance, 'category', v_cat);
  end if;

  /* ── Bank charge ── */
  if coalesce(p_bank_charge, 0) > 0 then
    v_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, payment_method, description,
       paid, paid_date, bank_account_id, reconciled_txn_id)
    values
      (v_id, v_txn.tenant_id, 'Bank Charges', null, v_txn.txn_date, p_bank_charge, 0, 'none', 'bank',
       'Bank charge on payment to ' || v_vendor.name, true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id);
    insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, created_by)
    values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'bank_charge', v_id, p_bank_charge, v_uid);
    v_cash := v_cash + p_bank_charge;
    v_charge := jsonb_build_object('expense_id', v_id, 'amount', p_bank_charge);
  end if;

  /* ── The legs must be the bank debit, to the rupee ── */
  if v_cash <> v_txn.debit then
    raise exception 'The parts add up to ₹% but the bank line is ₹% — adjust the amounts (difference ₹%).', v_cash, v_txn.debit, v_txn.debit - v_cash
      using errcode = '22023';
  end if;

  /* Teach the vendor its TDS section, once. */
  if v_tds_sec is not null and v_vendor.default_tds_section is null then
    update public.vendors set default_tds_section = v_tds_sec, updated_at = now() where id = v_vendor.id;
  end if;

  update public.bank_transactions
     set matched_to_type = 'vendor_payment', matched_to_id = v_vendor.id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = v_uid, updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object(
    'vendor_id', v_vendor.id, 'vendor_name', v_vendor.name, 'vendor_created', p_vendor_id is null,
    'bank_amount', v_txn.debit, 'paid', v_paid, 'new_bill', v_new, 'advance', v_adv, 'bank_charge', v_charge,
    'tds_total', v_tds_total, 'tds_section', v_tds_sec);
end;
$$;

revoke all on function public.reconcile_bank_debit_to_vendor(uuid, uuid, jsonb, jsonb, jsonb, integer, text, integer, text) from public, anon;
grant execute on function public.reconcile_bank_debit_to_vendor(uuid, uuid, jsonb, jsonb, jsonb, integer, text, integer, text) to authenticated, service_role;

-- ── 6. Prepaid → Book invoice: a COGS advance goes to the Bills page instead ────────────────
CREATE OR REPLACE FUNCTION public.consume_prepaid_fifo(p_vendor_name text, p_amount integer, p_gst integer DEFAULT 0, p_date date DEFAULT public.ist_today(), p_note text DEFAULT NULL::text, p_attachment text DEFAULT NULL::text, p_vendor_id uuid DEFAULT NULL::uuid, p_bill_no text DEFAULT NULL::text, p_igst integer DEFAULT NULL::integer, p_cgst integer DEFAULT NULL::integer, p_sgst integer DEFAULT NULL::integer, p_tds_section text DEFAULT NULL::text, p_tds_amount integer DEFAULT 0)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_available integer;
  v_left      integer := p_amount;
  v_gst_left  integer := greatest(0, coalesce(p_gst, 0));
  v_igst_left integer; v_cgst_left integer; v_sgst_left integer;
  v_adv       record;
  v_take      integer;
  v_gst_take  integer; v_igst_take integer; v_cgst_take integer; v_sgst_take integer;
  v_exp_id    text;
  v_parts     integer;
  v_part      integer := 0;
  v_vendor_id uuid;
  v_tds       integer := greatest(0, coalesce(p_tds_amount, 0));
  v_vname     text := trim(coalesce(p_vendor_name, ''));
  v_dup       record;
  v_cat       text;
  v_r         jsonb;
begin
  /* R-1914: an advance under a COGS head is refused here (Bills → Apply advance instead).
     R-1913: advances matched by vendor_id (name only for an advance with no vendor, F5); a bill
     already in the books is refused (B3 — apply the advance on it instead); an invoice bigger than
     the advance left becomes one unpaid bill with the advance applied (B2). */
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Invoice amount must be more than zero.'; end if;
  if v_gst_left > p_amount then raise exception 'GST (₹%) cannot be more than the invoice total (₹%).', v_gst_left, p_amount; end if;

  /* Heads: given → must add up to the GST; not given → all under CGST+SGST split evenly
     (what the GST page assumed before, now stated on the row instead of guessed later). */
  if p_igst is not null or p_cgst is not null or p_sgst is not null then
    v_igst_left := greatest(0, coalesce(p_igst, 0)); v_cgst_left := greatest(0, coalesce(p_cgst, 0)); v_sgst_left := greatest(0, coalesce(p_sgst, 0));
    if v_igst_left + v_cgst_left + v_sgst_left <> v_gst_left then
      raise exception 'IGST + CGST + SGST (₹%) must equal the GST (₹%).', v_igst_left + v_cgst_left + v_sgst_left, v_gst_left;
    end if;
  else
    v_igst_left := 0; v_cgst_left := v_gst_left / 2; v_sgst_left := v_gst_left - v_cgst_left;
  end if;
  if v_tds > p_amount - v_gst_left then raise exception 'TDS (₹%) cannot be more than the pre-GST value (₹%).', v_tds, p_amount - v_gst_left; end if;
  if v_tds > 0 and nullif(trim(coalesce(p_tds_section, '')), '') is null then raise exception 'Pick the TDS section for ₹% of TDS.', v_tds; end if;

  if p_vendor_id is not null then
    select name into v_vname from public.vendors where id = p_vendor_id and tenant_id = v_tenant;
    if not found then raise exception 'Vendor not found'; end if;
    v_vname := coalesce(nullif(trim(coalesce(p_vendor_name, '')), ''), v_vname);
  end if;

  /* B3: this vendor's bill with this number is already in the books — set the advance off there. */
  if nullif(trim(coalesce(p_bill_no, '')), '') is not null then
    select x.where_, x.bill_no, x.amount, x.paid into v_dup from (
      select 'Expenses'::text as where_, e.bill_no, e.amount, e.paid, e.created_at
        from public.expenses e
       where e.tenant_id = v_tenant
         and upper(trim(coalesce(e.bill_no, ''))) = upper(trim(p_bill_no))
         and (e.vendor_id = p_vendor_id
              or (e.vendor_id is null and upper(trim(coalesce(e.vendor_name, ''))) = upper(v_vname))
              or (p_vendor_id is null and upper(trim(coalesce(e.vendor_name, ''))) = upper(v_vname)))
      union all
      select 'Bills', b.bill_no, b.total, b.status = 'paid', b.created_at
        from public.vendor_bills b
       where b.tenant_id = v_tenant
         and upper(trim(coalesce(b.bill_no, ''))) = upper(trim(p_bill_no))
         and (b.vendor_id = p_vendor_id
              or (b.vendor_id is null and upper(trim(b.vendor_name)) = upper(v_vname))
              or (p_vendor_id is null and upper(trim(b.vendor_name)) = upper(v_vname)))
    ) x order by x.created_at limit 1;
    if found then
      raise exception 'Bill % of % (₹%) is already on the % page — booking it here would count the cost twice. Open it there and press "Apply advance".',
        v_dup.bill_no, v_vname, v_dup.amount, v_dup.where_ using errcode = 'unique_violation';
    end if;
  end if;

  perform 1 from public.prepaid_advances
    where tenant_id = v_tenant and closed_at is null and category <> 'Employee advance'
      and total_amount > consumed_amount
      and (vendor_id = p_vendor_id or (vendor_id is null and upper(trim(vendor_name)) = upper(v_vname))
           or (p_vendor_id is null and upper(trim(vendor_name)) = upper(v_vname)))
    for update;

  select coalesce(sum(total_amount - consumed_amount), 0), count(*)
    into v_available, v_parts
    from public.prepaid_advances
   where tenant_id = v_tenant and closed_at is null and category <> 'Employee advance'
     and total_amount > consumed_amount
     and (vendor_id = p_vendor_id or (vendor_id is null and upper(trim(vendor_name)) = upper(v_vname))
          or (p_vendor_id is null and upper(trim(vendor_name)) = upper(v_vname)));

  if v_available <= 0 then
    raise exception 'No advance is left with %. Record the advance first (reconcile its bank line as an advance), or record the bill on the Expenses page.',
      v_vname;
  end if;

  /* R-1914: a goods (COGS) vendor's advance is set off against its COGS bill on the Bills page —
     booking the invoice here would make it an expense (opex) row, not COGS. */
  if exists (select 1 from public.prepaid_advances
              where tenant_id = v_tenant and closed_at is null and category like 'COGS-%'
                and total_amount > consumed_amount
                and (vendor_id = p_vendor_id or (vendor_id is null and upper(trim(vendor_name)) = upper(v_vname))
                     or (p_vendor_id is null and upper(trim(vendor_name)) = upper(v_vname)))) then
    raise exception 'The advance with % is for goods (COGS) — record the invoice on the Bills page (Bills → Record a bill), then press "Apply advance" on it, so it counts as cost of goods.',
      v_vname using errcode = '22023';
  end if;

  /* Teach the advances their vendor, once. */
  if p_vendor_id is not null then
    update public.prepaid_advances set vendor_id = p_vendor_id, updated_at = now()
     where tenant_id = v_tenant and vendor_id is null and upper(trim(vendor_name)) = upper(v_vname);
  end if;

  /* B2: the invoice is bigger than the advance left → ONE bill for the full invoice, unpaid, with
     the whole advance applied to it; the rest stays due on the Expenses page. */
  if v_available < p_amount then
    select category, vendor_id into v_cat, v_vendor_id from public.prepaid_advances
     where tenant_id = v_tenant and closed_at is null and category <> 'Employee advance'
       and total_amount > consumed_amount
       and (vendor_id = p_vendor_id or (vendor_id is null and upper(trim(vendor_name)) = upper(v_vname))
            or (p_vendor_id is null and upper(trim(vendor_name)) = upper(v_vname)))
     order by paid_date, created_at, id limit 1;
    v_exp_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, vendor_id, amount, gst_paid, igst, cgst, sgst, expense_date, paid,
       bill_type, bill_no, description, notes, attachment_url, tds_section, tds_amount)
    values
      (v_exp_id, v_tenant, v_cat, v_vname, coalesce(p_vendor_id, v_vendor_id), p_amount, v_gst_left, v_igst_left, v_cgst_left, v_sgst_left, p_date, false,
       case when v_gst_left > 0 then 'gst' else 'none' end, nullif(trim(coalesce(p_bill_no, '')), ''),
       'Invoice from ' || v_vname || ' — advance applied, rest due', p_note, p_attachment,
       case when v_tds > 0 then trim(p_tds_section) end, v_tds);
    v_r := public.vendor_advance_apply_core(v_tenant, v_exp_id, least(v_available, p_amount - v_tds), p_date, public.current_user_id());
    return v_available - p_amount;
  end if;

  for v_adv in
    select * from public.prepaid_advances
     where tenant_id = v_tenant and closed_at is null and category <> 'Employee advance'
       and total_amount > consumed_amount
       and (vendor_id = p_vendor_id or (vendor_id is null and upper(trim(vendor_name)) = upper(v_vname))
            or (p_vendor_id is null and upper(trim(vendor_name)) = upper(v_vname)))
     order by paid_date, created_at, id
  loop
    exit when v_left <= 0;
    v_part := v_part + 1;
    v_take := least(v_left, v_adv.total_amount - v_adv.consumed_amount);
    if v_take = v_left then
      v_gst_take := v_gst_left; v_igst_take := v_igst_left; v_cgst_take := v_cgst_left; v_sgst_take := v_sgst_left;
    else
      v_gst_take  := least(v_gst_left,  round(coalesce(p_gst, 0)::numeric * v_take / p_amount)::int);
      v_igst_take := least(v_igst_left, round(v_igst_left::numeric * v_take / v_left)::int);
      v_cgst_take := least(v_cgst_left, round(v_cgst_left::numeric * v_take / v_left)::int);
      v_sgst_take := least(v_sgst_left, v_gst_take - v_igst_take - v_cgst_take);
    end if;
    v_vendor_id := coalesce(p_vendor_id, v_adv.vendor_id);

    v_exp_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, vendor_id, amount, gst_paid, igst, cgst, sgst, expense_date, paid, paid_date,
       bill_type, bill_no, payment_method, description, notes, attachment_url, prepaid_advance_id,
       tds_section, tds_amount)
    values
      (v_exp_id, v_tenant, v_adv.category, v_adv.vendor_name, v_vendor_id, v_take, v_gst_take, v_igst_take, v_cgst_take, v_sgst_take, p_date, true, p_date,
       case when v_gst_take > 0 then 'gst' else 'none' end, nullif(trim(coalesce(p_bill_no, '')), ''), 'advance',
       'Invoice from ' || v_adv.vendor_name || ' advance' ||
         case when v_take < p_amount then ' (part ' || v_part || ', ₹' || v_take || ' of ₹' || p_amount || ')' else '' end,
       p_note, p_attachment, v_adv.id,
       case when v_take = v_left and v_tds > 0 then trim(p_tds_section) end,
       case when v_take = v_left then v_tds else 0 end);

    update public.prepaid_advances
       set consumed_amount = consumed_amount + v_take, updated_at = now()
     where id = v_adv.id;

    v_left := v_left - v_take;
    v_gst_left := v_gst_left - v_gst_take; v_igst_left := v_igst_left - v_igst_take; v_cgst_left := v_cgst_left - v_cgst_take; v_sgst_left := v_sgst_left - v_sgst_take;
  end loop;

  return v_available - p_amount;
end;
$function$;

-- ── 7. Un-reconciling an advance already used: name the Bills page too ──────────────────────
create or replace function public.tg_vendor_payment_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r   public.bank_vendor_payment_lines;
  v_used integer;
  v_bill public.vendor_bills;
  v_left integer;
  v_keep boolean;
  b      record;
  v_e    public.expenses;
begin
  /* R-1913. R-1915: an expense bill's bank part comes off its paid_amount; latest part first.
     R-1914: the advance-used sentence names the Bills page too (COGS bills take advances). */
  if old.matched_to_type = 'vendor_payment'
     and (new.matched_to_type is distinct from 'vendor_payment' or new.matched_to_id is distinct from old.matched_to_id) then
    for r in select * from public.bank_vendor_payment_lines where bank_txn_id = old.id order by created_at, id loop
      delete from public.bank_vendor_payment_lines where id = r.id;
      if r.kind = 'bill' then
        -- R-1891: the bill was settled by cash + TDS (194Q); both come off.
        update public.vendor_bills
           set paid_amount = greatest(0, coalesce(paid_amount, 0) - r.cash - r.tds_amount),
               status = case when coalesce(paid_amount, 0) - r.cash - r.tds_amount <= 0 then 'unpaid'
                             when coalesce(paid_amount, 0) - r.cash - r.tds_amount < coalesce(total, 0) then 'partial' else 'paid' end,
               updated_at = now()
         where id = r.vendor_bill_id;
      elsif r.kind = 'expense' then
        -- R-1915: a part comes off only while nothing later rests on it.
        select * into v_e from public.expenses where id = r.expense_id for update;
        if v_e.paid and v_e.reconciled_txn_id is distinct from old.id then
          if exists (select 1 from public.bank_vendor_payment_lines l2
                      where l2.expense_id = r.expense_id and l2.kind = 'expense' and l2.bank_txn_id = v_e.reconciled_txn_id) then
            -- another bank part paid the last rupee
            raise exception 'A later bank payment is also on expense bill % — un-reconcile that one first, then this one.',
              coalesce(v_e.bill_no, v_e.id) using errcode = 'check_violation';
          end if;
          -- the rest was settled after this part (Mark paid, or the vendor's advance)
          raise exception 'Expense bill % was settled after this payment (% on %) — mark it unpaid first (Expenses), or undo the advance on it, then un-reconcile.',
            coalesce(v_e.bill_no, v_e.id), coalesce(v_e.payment_method, 'marked paid'), coalesce(to_char(v_e.paid_date, 'DD Mon YYYY'), 'an earlier date')
            using errcode = 'check_violation';
        end if;
        if r.tds_amount > 0 and exists (select 1 from public.bank_vendor_payment_lines l2
                      where l2.expense_id = r.expense_id and l2.kind = 'expense' and l2.bank_txn_id <> old.id) then
          -- this part withheld the bill's TDS; the other parts were worked out after it
          raise exception 'This payment withheld the TDS on expense bill %, and a later bank payment is also on it — un-reconcile that one first, then this one.',
            coalesce(v_e.bill_no, v_e.id) using errcode = 'check_violation';
        end if;
        update public.expenses
           set paid = false, reconciled_txn_id = null,
               paid_date = (r.prev->>'paid_date')::date,
               payment_method = r.prev->>'payment_method',
               bank_account_id = (r.prev->>'bank_account_id')::uuid,
               vendor_id = (r.prev->>'vendor_id')::uuid,
               paid_amount = greatest(0, coalesce(paid_amount, 0) - r.cash),
               tds_amount = coalesce((r.prev->>'tds_amount')::integer, 0),
               tds_section = r.prev->>'tds_section'
         where id = r.expense_id;
      elsif r.kind = 'new_bill' then
        -- R-1912: take off only THIS line's money. Delete the bill only when nothing else is on it
        -- (a Bills-page payment, a matched / R-1911 line, an open payment run, a PO allocation).
        select * into v_bill from public.vendor_bills where id = r.vendor_bill_id for update;
        if found then
          v_left := coalesce(v_bill.paid_amount, 0) - r.cash - r.tds_amount;
          v_keep := v_left > 0
                 or exists (select 1 from public.po_bill_allocations a where a.vendor_bill_id = v_bill.id);
          if not v_keep then
            select * into b from public.matched_bank_line_blocker(v_bill.tenant_id, 'vendor_bill', v_bill.id);
            v_keep := b.o_msg is not null;
          end if;
          if not v_keep then
            select * into b from public.vendor_bill_delete_blocker(v_bill.tenant_id, v_bill.id);
            v_keep := b.o_msg is not null;
          end if;
          if v_keep then
            update public.vendor_bills
               set paid_amount = greatest(0, v_left),
                   status = case when v_left <= 0 then 'unpaid'
                                 when v_left < coalesce(total, 0) then 'partial' else 'paid' end,
                   updated_at = now()
             where id = v_bill.id;
          else
            delete from public.vendor_bills where id = v_bill.id;
          end if;
        end if;
      elsif r.kind = 'new_expense' then
        -- R-1912: refuse up front (naming what to do) rather than orphan another bank line on it.
        select * into b from public.matched_bank_line_blocker(old.tenant_id, 'expense', r.expense_id);
        if b.o_msg is not null then
          raise exception 'This bank line recorded expense bill %, and another bank line is also matched to it. Un-reconcile that other line first (Banking), then undo this one — otherwise it would point at a deleted expense.', r.expense_id
            using errcode = 'check_violation', hint = b.o_href;
        end if;
        delete from public.expenses where id = r.expense_id;
      elsif r.kind = 'bank_charge' then
        delete from public.expenses where id = r.expense_id;
      elsif r.kind = 'advance' then
        select consumed_amount into v_used from public.prepaid_advances where id = r.prepaid_advance_id;
        if coalesce(v_used, 0) > 0 then
          -- R-1913: an advance is used either by a Prepaid invoice or by "Apply advance" on a bill.
          raise exception 'This payment''s advance to the vendor has ₹% already used against bills. Undo it there first (Expenses or Bills → the bill → Undo advance, or delete the invoice on the Prepaid page), then un-reconcile.', v_used
            using errcode = 'check_violation';
        end if;
        delete from public.prepaid_advances where id = r.prepaid_advance_id;
      elsif r.kind = 'recorded_payment' then
        -- R-1911: this line had replaced a payment recorded outside the bank. Put it back as it was:
        -- the Bills-page / payment-run manual line returns (paid_amount never moved), a Mark-paid
        -- expense is "paid, waiting for its bank line" again.
        if jsonb_typeof(r.prev->'synthetic') = 'object' then
          insert into public.bank_transactions
          select * from jsonb_populate_record(null::public.bank_transactions, r.prev->'synthetic');
        end if;
        if r.expense_id is not null and jsonb_typeof(r.prev->'expense') = 'object' then
          update public.expenses
             set reconciled_txn_id = (r.prev->'expense'->>'reconciled_txn_id')::uuid,
                 paid_date = (r.prev->'expense'->>'paid_date')::date,
                 payment_method = r.prev->'expense'->>'payment_method',
                 bank_account_id = (r.prev->'expense'->>'bank_account_id')::uuid
           where id = r.expense_id;
        end if;
      end if;
    end loop;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_vendor_payment_line_unmatched() from public, anon;

commit;
