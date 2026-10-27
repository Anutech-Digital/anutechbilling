-- deploy-peek: to_regclass('public.vendor_advance_applications') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'advance_applied') and to_regprocedure('public.apply_vendor_advance(text,text,integer,date)') is not null and to_regprocedure('public.undo_vendor_advance(text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.consume_prepaid_fifo(text,integer,integer,date,text,text,uuid,text,integer,integer,integer,text,integer)') and prosrc like '%R-1913%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_debit_to_vendor(uuid,uuid,jsonb,jsonb,jsonb,integer,text,integer,text)') and prosrc like '%R-1913%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_debit_vendor_open_items(uuid)') and prosrc like '%R-1913%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.report_balance_sheet(date)') and prosrc like '%R-1913%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_vendor_payment_line_unmatched()') and prosrc like '%R-1913%')
-- deploy-key: r1913applyvendoradvance
-- 20261025164002_r1913_apply_vendor_advance.sql
--
-- R-1913 (25 Oct 2026, p1 — R-1906 audit B2 + B3): a vendor advance could not be set off against a
-- bill, in part or against a bill already in the books.
--
-- ─── THE BUGS (proven, Anutech-HQ/drafts/R-1906/r1906_audit_proofs.sql) ──────────────────────
--   B2  Advance ₹30,000 to Verma, then Verma's ₹50,000 bill: Prepaid → Book invoice
--       (consume_prepaid_fifo) refused "Only ₹30000 is left…" — the bill could not take the
--       advance and leave ₹20,000 payable.
--   B3  Verma's ₹20,000 bill already on the Expenses page (unpaid) + Prepaid → Book invoice →
--       a SECOND expense row: cost ₹40,000, and the first bill still open / payable.
--
-- ─── THE FIX ────────────────────────────────────────────────────────────────────────────────
--   expenses.advance_applied — the part of an expense bill settled from the vendor's advances.
--     What is still owed on the bill = amount − TDS − advance_applied. Settled in full → the bill
--     is paid (payment_method 'advance', paid_date = the day applied).
--   vendor_advance_applications — one row per advance used on a bill (FIFO), so undo puts back
--     exactly what was taken.
--   apply_vendor_advance(p_source, p_doc_id, p_amount, p_date) — ONE transaction (§17b):
--     takes min(advance left, bill due) (or the amount asked) from the vendor's advances, oldest
--     first, matched by vendor_id (or the name when the advance has no vendor yet). No new
--     expense row: the cost is the bill already booked; the advance (asset) and the payable both
--     go down. Expense (services) bills only — COGS bills are R-1914.
--   undo_vendor_advance(p_expense_id) — gives the advance back and reopens the bill. Refused while
--     a bank line / Mark-paid settled the rest of the bill (undo that first).
--   Deleting a bill that took an advance gives the advance back (trigger); its amount cannot be
--     cut below what the advance already settled (trigger, with a sentence).
--   consume_prepaid_fifo (Prepaid → Book invoice) — only for a bill NOT in the books yet:
--     · refuses a bill number this vendor already has on the Expenses / Bills page (B3) and says
--       "Apply advance" on that bill;
--     · an invoice bigger than the advance left becomes ONE unpaid bill for the full amount with
--       the advance applied to it (B2) — returns advance left − invoice, i.e. −(still due);
--     · advances are matched by vendor_id first, the name only for advances with no vendor (F5).
--   Readers of "still owed" take advance_applied off: bank_debit_vendor_open_items,
--     reconcile_bank_debit_to_vendor (the bank line pays the rest; Mark-paid match = the rest),
--     report_balance_sheet (expenses_payable / expenses_paid_unbanked).
--   tg_vendor_payment_line_unmatched: the "advance already used" refusal now says where to undo it.
--
-- Started from the LATEST definitions:
--   bank_debit_vendor_open_items, reconcile_bank_debit_to_vendor  20261025100013 (R-1911)
--   tg_vendor_payment_line_unmatched                              20261025151118 (R-1912)
--   report_balance_sheet                                          20261025030249 (R-1849)
--   consume_prepaid_fifo                                          20261024091100 (R-1830)
-- Guards: §17c fail-closed tenant check, R-718 money roles (owner, manager, accountant, billing).
-- Stored data is not changed (advance_applied defaults to 0 = today's meaning).
-- Test: supabase/tests/r1913_apply_vendor_advance.test.sql

begin;

-- ── 1. The part of an expense bill settled from advances ─────────────────────────────────────
alter table public.expenses add column if not exists advance_applied integer not null default 0;
alter table public.expenses drop constraint if exists expenses_advance_applied_check;
alter table public.expenses add constraint expenses_advance_applied_check check (advance_applied >= 0);
comment on column public.expenses.advance_applied is
  'R-1913: the part of this expense bill settled from the vendor''s advances (vendor_advance_applications). Still owed = amount − tds_amount − advance_applied.';

create table if not exists public.vendor_advance_applications (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references public.tenants(id) on delete cascade,
  prepaid_advance_id uuid        not null references public.prepaid_advances(id),
  expense_id         text        not null references public.expenses(id),
  amount             integer     not null check (amount > 0),
  applied_on         date        not null,
  -- The bill's paid fields before this application settled it (null when it left the bill open).
  prev               jsonb,
  created_by         uuid,
  created_at         timestamptz not null default now()
);
comment on table public.vendor_advance_applications is
  'R-1913: a vendor advance (prepaid_advances) set off against an expense bill already in the books. Written only by apply_vendor_advance / consume_prepaid_fifo; undo_vendor_advance and deleting the bill reverse it.';
create index if not exists vendor_advance_applications_exp_idx on public.vendor_advance_applications (expense_id);
create index if not exists vendor_advance_applications_adv_idx on public.vendor_advance_applications (prepaid_advance_id);
create index if not exists vendor_advance_applications_tenant_idx on public.vendor_advance_applications (tenant_id);

alter table public.vendor_advance_applications enable row level security;
drop policy if exists "tenant isolation read" on public.vendor_advance_applications;
drop policy if exists zzz_service_role_all on public.vendor_advance_applications;
create policy "tenant isolation read" on public.vendor_advance_applications for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));
create policy zzz_service_role_all on public.vendor_advance_applications as permissive for all to service_role
  using (true) with check (true);
revoke all on public.vendor_advance_applications from anon;
grant select on public.vendor_advance_applications to authenticated;
grant select, insert, update, delete on public.vendor_advance_applications to service_role;

-- ── 2. Bill edits: never below what the advance settled; delete gives the advance back ───────
create or replace function public.tg_expense_advance_applied_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-1913 */
  if tg_op = 'DELETE' then
    if coalesce(old.advance_applied, 0) > 0 then
      update public.prepaid_advances pa
         set consumed_amount = greatest(0, pa.consumed_amount - a.amount), updated_at = now()
        from public.vendor_advance_applications a
       where a.expense_id = old.id and pa.id = a.prepaid_advance_id;
      delete from public.vendor_advance_applications where expense_id = old.id;
    end if;
    return old;
  end if;
  if coalesce(new.advance_applied, 0) > 0
     and new.advance_applied > coalesce(new.amount, 0) - coalesce(new.tds_amount, 0) then
    raise exception 'Bill % has ₹% settled from the vendor''s advance — undo the advance on it first (Expenses → the bill → Undo advance), then change the amount or TDS.',
      coalesce(new.bill_no, new.id), new.advance_applied using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_expense_advance_applied_guard() from public, anon;
drop trigger if exists trg_expense_advance_applied_guard on public.expenses;
create trigger trg_expense_advance_applied_guard
  before update of amount, tds_amount, advance_applied or delete on public.expenses
  for each row execute function public.tg_expense_advance_applied_guard();

-- ── 3. The one place that sets an advance off against a bill (internal, not callable) ────────
--   Takes up to p_amount (null = as much as fits) from the vendor's open advances, oldest first.
--   Caller has checked tenant + role and locked nothing yet.
create or replace function public.vendor_advance_apply_core(p_tenant uuid, p_expense_id text, p_amount integer, p_date date, p_uid uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exp    public.expenses;
  v_vendor public.vendors;
  v_name   text;
  v_due    integer;
  v_avail  integer;
  v_want   integer;
  v_left   integer;
  v_take   integer;
  v_adv    record;
  v_prev   jsonb;
  v_settle boolean;
  v_parts  jsonb := '[]'::jsonb;
begin
  /* R-1913 */
  select * into v_exp from public.expenses where id = p_expense_id for update;
  if not found or v_exp.tenant_id is distinct from p_tenant then
    raise exception 'Expense bill % not found in your company', p_expense_id using errcode = '42501';
  end if;
  if v_exp.paid or v_exp.reconciled_txn_id is not null then
    raise exception 'Bill % is already paid — an advance can only be applied to a bill still to pay.', coalesce(v_exp.bill_no, v_exp.id)
      using errcode = 'check_violation';
  end if;
  if upper(coalesce(v_exp.currency, 'INR')) <> 'INR' or v_exp.category = 'Salaries'
     or coalesce(v_exp.payment_method, '') in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
     or v_exp.prepaid_advance_id is not null then
    raise exception 'Expense % is not a vendor bill an advance can be applied to.', coalesce(v_exp.bill_no, v_exp.id) using errcode = '22023';
  end if;
  if v_exp.vendor_id is not null then
    select * into v_vendor from public.vendors where id = v_exp.vendor_id and tenant_id = p_tenant;
  end if;
  v_name := coalesce(v_vendor.name, nullif(trim(coalesce(v_exp.vendor_name, '')), ''));
  if v_name is null then
    raise exception 'Bill % has no vendor — pick the vendor on the bill first.', coalesce(v_exp.bill_no, v_exp.id) using errcode = '22023';
  end if;

  v_due := v_exp.amount - coalesce(v_exp.tds_amount, 0) - coalesce(v_exp.advance_applied, 0);
  if v_due <= 0 then
    raise exception 'Nothing is left to pay on bill %.', coalesce(v_exp.bill_no, v_exp.id) using errcode = 'check_violation';
  end if;

  /* The vendor's open advances: by vendor id, or by name for an advance that has no vendor yet. */
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
    if p_amount > v_due then
      raise exception 'Only ₹% is still to pay on bill % — apply at most that.', v_due, coalesce(v_exp.bill_no, v_exp.id) using errcode = '22023';
    end if;
    if p_amount > v_avail then
      raise exception 'Only ₹% of advance is left with % — apply at most that.', v_avail, v_name using errcode = '22023';
    end if;
  end if;
  v_want := coalesce(p_amount, least(v_due, v_avail));
  v_settle := v_want = v_due;
  v_prev := case when v_settle then jsonb_build_object('paid_date', v_exp.paid_date, 'payment_method', v_exp.payment_method) end;

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
    insert into public.vendor_advance_applications (tenant_id, prepaid_advance_id, expense_id, amount, applied_on, prev, created_by)
    values (p_tenant, v_adv.id, v_exp.id, v_take, p_date, case when v_left <= 0 then v_prev end, p_uid);
    v_parts := v_parts || jsonb_build_object('advance_id', v_adv.id, 'paid_date', v_adv.paid_date, 'amount', v_take);
  end loop;

  update public.expenses
     set advance_applied = coalesce(advance_applied, 0) + v_want,
         paid = case when v_settle then true else paid end,
         paid_date = case when v_settle then p_date else paid_date end,
         payment_method = case when v_settle then 'advance' else payment_method end,
         vendor_id = coalesce(vendor_id, v_vendor.id)
   where id = v_exp.id;

  return jsonb_build_object('expense_id', v_exp.id, 'bill_no', v_exp.bill_no, 'vendor_name', v_name,
    'applied', v_want, 'still_due', v_due - v_want, 'settled', v_settle,
    'advance_left', v_avail - v_want, 'parts', v_parts);
end;
$$;
revoke all on function public.vendor_advance_apply_core(uuid, text, integer, date, uuid) from public, anon, authenticated;

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
  /* R-1913: §17c fail-closed + R-718 money roles. */
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
  if p_source = 'vendor_bill' then
    raise exception 'An advance cannot be applied to a COGS (goods) bill yet — only to expense bills.' using errcode = '22023';
  end if;
  if p_source is distinct from 'expense' or p_doc_id is null then
    raise exception 'Pick the bill to apply the advance to.' using errcode = '22023';
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
  v_total   integer;
  v_prev    jsonb;
begin
  /* R-1913: §17c fail-closed + R-718 money roles. */
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
  if not found or (v_caller is not null and v_exp.tenant_id is distinct from v_caller) then
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

-- ── 5. Prepaid → Book invoice: only a bill not in the books yet (B3); bigger than the advance (B2) ──
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
  /* R-1913: advances matched by vendor_id (name only for an advance with no vendor, F5); a bill
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

-- ── 6. Open items: an expense bill is owed less the advance applied (R-1913) ──
create or replace function public.bank_debit_vendor_open_items(p_vendor_id uuid)
returns table (
  source      text,      -- recorded_payment (R-1911, listed first) | vendor_bill (COGS bill) | expense (unpaid expense bill)
  doc_id      text,      -- recorded_payment: the manual bank line's id, or the Mark-paid expense's id
  bill_no     text,
  doc_date    date,
  due_date    date,
  category    text,
  total       integer,   -- the document's gross total
  amount_due  integer,   -- still owed, gross (before TDS); recorded_payment: the cash recorded as paid
  gst         integer,
  tds_base    integer,   -- value before GST (the TDS base)
  tds_amount  integer,   -- TDS already on the expense row (0 for a COGS bill)
  tds_section text,
  can_part    boolean,   -- a COGS bill can be part-paid; an expense bill is paid in full
  in_run      text,      -- an open payment run that holds it (pay it there, or cancel the run)
  paid_on     date,      -- R-1911 recorded_payment: the date it was recorded as paid
  pays_source text,      -- R-1911 recorded_payment: vendor_bill | expense
  pays_doc_id text       -- R-1911 recorded_payment: the bill / expense it paid
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_vendor  public.vendors;
begin
  /* R-1866 / §17c: fail closed for a login with no company. R-1911: recorded payments added. R-1913: less the advance applied. */
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
  select * into v_vendor from public.vendors where id = p_vendor_id;
  if not found or (v_caller is not null and v_vendor.tenant_id is distinct from v_caller) then
    return;   -- another company's vendor: nothing, as "not found"
  end if;

  return query
  select x.* from (
    -- R-1911 (a): a manual bank line of this vendor's bill / expense (Bills page Pay, payment run).
    select 'recorded_payment'::text, t.id::text, coalesce(b.bill_no, e.bill_no), t.txn_date, null::date,
           coalesce(b.category, e.category), coalesce(b.total, e.amount), t.debit, 0, 0, 0, null::text, false,
           null::text, t.txn_date, t.matched_to_type, t.matched_to_id
      from public.bank_transactions t
      left join public.vendor_bills b on t.matched_to_type = 'vendor_bill' and b.id = t.matched_to_id and b.tenant_id = t.tenant_id
      left join public.expenses e     on t.matched_to_type = 'expense' and e.id = t.matched_to_id and e.tenant_id = t.tenant_id
     where t.tenant_id = v_vendor.tenant_id
       and t.source = 'manual' and t.matched_to_type in ('vendor_bill', 'expense') and coalesce(t.debit, 0) > 0
       and (b.id is not null or e.id is not null)
       and coalesce(b.vendor_id = v_vendor.id or (b.vendor_id is null and upper(trim(b.vendor_name)) = upper(trim(v_vendor.name))),
                    e.vendor_id = v_vendor.id or (e.vendor_id is null and upper(trim(coalesce(e.vendor_name, ''))) = upper(trim(v_vendor.name))),
                    false)
    union all
    -- R-1911 (b): an expense marked paid with no bank line (Expenses → Mark paid), not cash.
    select 'recorded_payment'::text, e.id, e.bill_no, coalesce(e.paid_date, e.expense_date), e.due_date, e.category,
           -- amount_due = the cash recorded (TDS already withheld on the expense stays there; 0 here,
           -- so "cash due = amount_due − tds_amount" holds for every row)
           e.amount, e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0), coalesce(e.gst_paid, 0), greatest(0, e.amount - coalesce(e.gst_paid, 0)),
           0, null::text, false, null::text, coalesce(e.paid_date, e.expense_date), 'expense'::text, e.id
      from public.expenses e
     where e.tenant_id = v_vendor.tenant_id
       and (e.vendor_id = v_vendor.id or (e.vendor_id is null and upper(trim(coalesce(e.vendor_name, ''))) = upper(trim(v_vendor.name))))
       and e.paid = true and e.reconciled_txn_id is null
       and upper(coalesce(e.currency, 'INR')) = 'INR'
       and e.category <> 'Salaries'
       and lower(coalesce(e.payment_method, '')) not in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
       and e.prepaid_advance_id is null
       and e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) > 0
       and not exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id)
    union all
    select 'vendor_bill'::text, b.id, b.bill_no, b.bill_date, b.due_date, b.category,
           b.total, greatest(0, b.total - coalesce(b.paid_amount, 0)),
           (b.cgst + b.sgst + b.igst), b.subtotal, 0, null::text, true,
           (select pr.run_no from public.payment_run_items it join public.payment_runs pr on pr.id = it.run_id
             where it.tenant_id = b.tenant_id and it.source = 'vendor_bill' and it.doc_id = b.id
               and pr.status in ('draft', 'approved') limit 1),
           null::date, null::text, null::text
      from public.vendor_bills b
     where b.tenant_id = v_vendor.tenant_id
       and (b.vendor_id = v_vendor.id or (b.vendor_id is null and upper(trim(b.vendor_name)) = upper(trim(v_vendor.name))))
       and coalesce(b.status, 'unpaid') <> 'paid'
       and upper(coalesce(b.currency, 'INR')) = 'INR'
       and b.total - coalesce(b.paid_amount, 0) > 0
    union all
    select 'expense'::text, e.id, e.bill_no, e.expense_date, e.due_date, e.category,
           e.amount, e.amount - coalesce(e.advance_applied, 0), coalesce(e.gst_paid, 0), greatest(0, e.amount - coalesce(e.gst_paid, 0)),
           coalesce(e.tds_amount, 0), e.tds_section, false,
           (select pr.run_no from public.payment_run_items it join public.payment_runs pr on pr.id = it.run_id
             where it.tenant_id = e.tenant_id and it.source = 'expense' and it.doc_id = e.id
               and pr.status in ('draft', 'approved') limit 1),
           null::date, null::text, null::text
      from public.expenses e
     where e.tenant_id = v_vendor.tenant_id
       and (e.vendor_id = v_vendor.id or (e.vendor_id is null and upper(trim(coalesce(e.vendor_name, ''))) = upper(trim(v_vendor.name))))
       and e.paid = false and e.reconciled_txn_id is null
       and upper(coalesce(e.currency, 'INR')) = 'INR'
       and e.category <> 'Salaries'
       and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
       and e.prepaid_advance_id is null
       and e.amount - coalesce(e.advance_applied, 0) > 0
  ) as x(c_source, c_doc_id, c_bill_no, c_doc_date, c_due_date, c_category, c_total, c_amount_due, c_gst, c_tds_base,
         c_tds_amount, c_tds_section, c_can_part, c_in_run, c_paid_on, c_pays_source, c_pays_doc_id)
  order by (x.c_source = 'recorded_payment') desc, x.c_doc_date, x.c_doc_id;
end;
$$;
revoke all on function public.bank_debit_vendor_open_items(uuid) from public, anon;
grant execute on function public.bank_debit_vendor_open_items(uuid) to authenticated, service_role;

-- ── 7. Pay a vendor from a bank line: an expense bill's payment is what is left after the advance (R-1913) ──
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
  v_q         record;   -- R-1891: vendor_bill_194q_calc of the bill
  v_qbase     integer := 0;
  v_syn       public.bank_transactions;   -- R-1911: the manual (Bills page / payment run) line being matched
  v_prev      jsonb;
  v_rec_paid  date;
  v_rec_where text;
begin
  /* §17c fail-closed + R-718 money roles. */
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
    select * into v_vendor from public.vendors
     where tenant_id = v_txn.tenant_id
       and ((v_gstin is not null and upper(gstin) = v_gstin) or upper(trim(name)) = upper(v_name))
     order by (v_gstin is not null and upper(gstin) = v_gstin) desc, created_at
     limit 1 for update;
    if not found then
      insert into public.vendors (tenant_id, name, gstin, pan, default_tds_section)
      values (v_txn.tenant_id, v_name, v_gstin, v_pan, nullif(upper(trim(coalesce(p_new_vendor->>'tds_section', ''))), ''))
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
           or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = v_exp.id) then
          raise exception 'Expense % is not a payment waiting for its bank line (unpaid, or already matched).', coalesce(v_exp.bill_no, v_doc) using errcode = 'check_violation';
        end if;
        if upper(coalesce(v_exp.currency, 'INR')) <> 'INR' or v_exp.prepaid_advance_id is not null or v_exp.category = 'Salaries'
           or lower(coalesce(v_exp.payment_method, '')) in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance') then
          raise exception 'Expense % was not paid from a bank — it cannot be matched to a bank line.', coalesce(v_exp.bill_no, v_doc) using errcode = '22023';
        end if;
        -- R-1913: the part settled from the vendor's advance never went through a bank.
        if v_amt <> v_exp.amount - coalesce(v_exp.tds_amount, 0) - coalesce(v_exp.advance_applied, 0) then
          raise exception 'Expense % was paid ₹% from the bank (₹% less TDS ₹% and advance applied ₹%) — match all of it, not ₹%.', coalesce(v_exp.bill_no, v_doc),
            v_exp.amount - coalesce(v_exp.tds_amount, 0) - coalesce(v_exp.advance_applied, 0), v_exp.amount, coalesce(v_exp.tds_amount, 0),
            coalesce(v_exp.advance_applied, 0), v_amt using errcode = '22023';
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
      -- R-1913: what is left after the vendor's advance applied to it is paid in full here.
      if v_amt <> v_exp.amount - coalesce(v_exp.advance_applied, 0) then
        if coalesce(v_exp.advance_applied, 0) > 0 then
          raise exception 'Expense bill % has ₹% left to pay after the advance applied (₹%) — pay all of it (₹%), not ₹%.', coalesce(v_exp.bill_no, v_doc),
            v_exp.amount - v_exp.advance_applied, v_exp.advance_applied, v_exp.amount - v_exp.advance_applied, v_amt using errcode = '22023';
        end if;
        raise exception 'Expense bill % is paid in full (₹%), not ₹%. For a part payment, book the money as an advance.', coalesce(v_exp.bill_no, v_doc), v_exp.amount, v_amt
          using errcode = '22023';
      end if;
      if v_tds > v_amt then
        raise exception 'TDS ₹% is more than the ₹% left to pay on bill %.', v_tds, v_amt, coalesce(v_exp.bill_no, v_doc) using errcode = '22023';
      end if;
      if coalesce(v_exp.tds_amount, 0) > 0 and v_tds <> v_exp.tds_amount then
        raise exception 'Expense bill % already has ₹% TDS recorded — the payment must use the same TDS.', coalesce(v_exp.bill_no, v_doc), v_exp.tds_amount
          using errcode = '22023';
      end if;
      if v_tds > greatest(0, v_exp.amount - coalesce(v_exp.gst_paid, 0)) then
        raise exception 'TDS ₹% cannot be more than the value before GST (₹%).', v_tds, greatest(0, v_exp.amount - coalesce(v_exp.gst_paid, 0)) using errcode = '22023';
      end if;
      v_sec := case when v_tds > 0 then coalesce(v_sec, nullif(upper(trim(coalesce(v_exp.tds_section, ''))), '')) end;
      if v_tds > 0 and v_sec is null then raise exception 'Pick the TDS section for ₹% of TDS.', v_tds using errcode = '22023'; end if;

      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, tds_amount, tds_section, prev, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'expense', v_doc, v_amt - v_tds, v_tds, v_sec,
              jsonb_build_object('tds_amount', v_exp.tds_amount, 'tds_section', v_exp.tds_section, 'paid_date', v_exp.paid_date,
                                 'payment_method', v_exp.payment_method, 'bank_account_id', v_exp.bank_account_id, 'vendor_id', v_exp.vendor_id),
              v_uid);
      update public.expenses
         set paid = true, paid_date = v_txn.txn_date, payment_method = 'bank',
             bank_account_id = v_txn.bank_account_id, reconciled_txn_id = p_txn_id,
             vendor_id = coalesce(vendor_id, v_vendor.id),
             tds_amount = v_tds, tds_section = case when v_tds > 0 then v_sec else tds_section end
       where id = v_doc;
      v_cash := v_cash + (v_amt - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      v_paid := v_paid || jsonb_build_object('source', 'expense', 'doc_id', v_doc, 'bill_no', v_exp.bill_no,
                 'settled', v_amt, 'cash', v_amt - v_tds, 'tds', v_tds, 'tds_section', v_sec, 'status', 'paid', 'still_due', 0);
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
    v_cat := coalesce(nullif(trim(coalesce(p_advance_category, '')), ''),
                      case when coalesce(v_vendor.default_category, '') not like 'COGS-%' then nullif(trim(v_vendor.default_category), '') end,
                      'Other');
    if v_cat = 'Salaries' or v_cat like 'COGS-%' then
      raise exception 'Pick the expense category the advance will be used for.' using errcode = '22023';
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

-- ── 8. Un-reconcile: the advance-used refusal says where to undo it (R-1913) ──
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
begin
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
        update public.expenses
           set paid = false, reconciled_txn_id = null,
               paid_date = (r.prev->>'paid_date')::date,
               payment_method = r.prev->>'payment_method',
               bank_account_id = (r.prev->>'bank_account_id')::uuid,
               vendor_id = (r.prev->>'vendor_id')::uuid,
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
          raise exception 'This payment''s advance to the vendor has ₹% already used against bills. Undo it there first (Expenses → the bill → Undo advance, or delete the invoice on the Prepaid page), then un-reconcile.', v_used
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

-- ── 9. Balance Sheet: payables less the advance already applied (R-1913) ──
CREATE OR REPLACE FUNCTION public.report_balance_sheet(p_as_of date DEFAULT NULL::date)
 RETURNS TABLE(as_of date, fy_start_year integer, fy_label text, cash_and_bank bigint, undeposited_funds bigint, credit_card_payable bigint, receivables bigint, advances_from_customers bigint, project_receivable bigint, tds_receivable bigint, employee_loans bigint, prepaid_advances bigint, emi_unregistered_cost bigint, emi_loans_payable bigint, business_loans_payable bigint, payables bigint, salary_payable bigint, dues_salary_tds bigint, dues_pf bigint, dues_esi bigint, dues_vendor_tds bigint, dues_paid jsonb, reimbursements_payable bigint, gst_output bigint, bills_gst bigint, itc_groups jsonb, fixed_assets jsonb, tax_payments jsonb, expenses_payable bigint, expenses_paid_unbanked bigint, salary_other_deductions bigint, bill_itc_groups jsonb, commissions_payable bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  -- R-1580: commission TDS in dues_vendor_tds; commissions_payable.
  -- R-1739: gst_output skips imported Zoho opening invoices (receivables keep them).
  -- R-1849: partner TDS in dues_vendor_tds.
  -- R-1913: expenses_payable / expenses_paid_unbanked less the advance applied to the bill (the advance left the prepaid asset when applied).
  v_tenant  uuid := public.current_tenant_id();
  v_to      date := coalesce(p_as_of, (now() at time zone 'Asia/Kolkata')::date);
  v_fy_year int;
  v_cash    bigint;
  v_card    bigint;
  v_own_state text;
begin
  if v_tenant is null then
    raise exception 'Balance sheet nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Indian FY: April se pehle ke mahine pichhle saal ke FY me.
  v_fy_year := case when extract(month from v_to) < 4 then extract(year from v_to)::int - 1
                    else extract(year from v_to)::int end;

  -- Cash & bank: har account = opening + sum(credit − debit), ek hi pass me (N+1 khatam).
  -- Credit card liability hai: negative = card par bakaya; positive (overpaid) = cash.
  select coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then 0 else b.bal end), 0),
         coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then -b.bal else 0 end), 0)
    into v_cash, v_card
    from (
      select a.account_type,
             a.opening_balance::bigint + coalesce((
               select sum(t.credit - t.debit)
                 from public.bank_transactions t
                where t.bank_account_id = a.id and t.tenant_id = v_tenant), 0) as bal
        from public.bank_accounts a
       where a.tenant_id = v_tenant
    ) b;

  -- R-1576: hamara rajya (state check ke liye) — report.ts jaisa: state_code, warna GSTIN ke pehle 2.
  select coalesce(nullif(trim(t.state_code), ''), nullif(left(trim(coalesce(t.gstin, '')), 2), ''))
    into v_own_state from public.tenants t where t.id = v_tenant;

  return query
  select
    v_to,
    v_fy_year,
    'FY ' || v_fy_year || '-' || lpad(((v_fy_year + 1) % 100)::text, 2, '0'),
    v_cash,
    -- R-179: receipts jo kisi bank line se match nahi hue — paisa haath me, asset.
    -- S45-TB: payment.amount me customer ka kaata hua TDS bhi hai (record_payment_with_tds
    -- invoice ko gross se settle karta hai). Wo TDS paisa kabhi aaya hi nahi — tds_receivable
    -- me asset hai. Yahan bhi gina to ek hi ₹ do baar Dr. Isliye us payment ka TDS ghatao.
    -- R-1612: amount − credit_applied — advance credit inside a payment was money in on the
    -- payment that created it (R-1565), not again here.
    ((select coalesce(sum(p.amount - p.credit_applied - coalesce((select sum(t.tds_amount) from public.tds_receivable t
                                                where t.tenant_id = v_tenant and t.payment_id = p.id), 0)
                                  -- S45-SLICE2: Razorpay fee book ho chuki (EXP-RZPFEE-<id>, R-045) to wo
                                  -- paisa kabhi bank me nahi aayega — fee P&L me hai, yahan bhi gini to do baar.
                                  - coalesce((select e.amount from public.expenses e
                                               where e.tenant_id = v_tenant and e.id = 'EXP-RZPFEE-' || p.id::text), 0)), 0)
        from public.payments p
       where p.tenant_id = v_tenant and p.status = 'received'
         and not exists (select 1 from public.bank_transactions t
                          where t.tenant_id = v_tenant and t.matched_to_type = 'payment'
                            and t.matched_to_id = p.id::text))
   + (select coalesce(sum(pp.amount), 0)
        from public.project_payments pp
       where pp.tenant_id = v_tenant and pp.bank_txn_id is null))::bigint,
    v_card,
    -- Trade receivables (accrual): pending/overdue, project-milestone invoices CHHOD kar
    -- (wo project_receivable me hain — dono me gine to double count).
    -- S45-TB: net_payable − paid_amount. record_payment har part payment par paid_amount
    -- likhta hai (R-015) aur Aging bhi yahi padhta hai; poora net_payable ginne se ₹40,000
    -- ka part payment cash me bhi aur receivable me bhi — TB me utna farq.
    (select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))), 0)::bigint
       from public.invoices i
      where i.tenant_id = v_tenant
        and i.status in ('pending', 'overdue')
        and not exists (select 1 from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.invoice_id = i.id)),
    -- Customer advances: received payments jinke quote par abhi invoice nahi — liability.
    -- S45-TB: + invoice ke BAAD customer ka bakaaya paisa (overpayment, ya paid invoice par
    -- credit note): quote par mila − (invoice − credit notes + debit notes), jab > 0. Pehle
    -- ye kahin nahi tha — paisa cash me, deni-daari kahin nahi. Sirf quote ka apna ek hi
    -- invoice (split billing ke kai invoice wale quote chhode — wahan ye hisaab nahi banta).
    -- R-1612: (1) − the overpayment credit those payments opened (open credit is in (3); used
    -- credit sits in the payment that used it) − what is applied to the quote's raised
    -- instalment invoices (split billing: no invoice of its own, R-1564); (2) − the same
    -- credit; (3) + the customer's open (unused) credit.
    ((select coalesce(sum(greatest(0,
               (select coalesce(sum(p.amount), 0) from public.payments p
                 where p.tenant_id = v_tenant and p.quote_id = q.id and p.status = 'received')
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                 join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant
                where cc.tenant_id = v_tenant and cc.source in ('overpayment', 'redeemed_split')  -- R-1614: + the used part of a split
                  and p.quote_id = q.id and p.status = 'received')
             - (select coalesce(sum(i.paid_amount), 0)
                  from public.subscriptions s
                  join public.subscription_billings b on b.subscription_id = s.id and b.tenant_id = v_tenant
                  join public.invoices i on i.id = b.invoice_id and i.tenant_id = v_tenant
                 where s.tenant_id = v_tenant and s.quote_id = q.id
                   and i.status in ('pending', 'paid', 'overdue')))), 0)
        from public.quotes q
       where q.tenant_id = v_tenant and q.invoice_id is null)
   + (select coalesce(sum(greatest(0,
               (select coalesce(sum(p.amount), 0) from public.payments p
                 where p.tenant_id = v_tenant and p.quote_id = q.id and p.status = 'received')
             - (i.amount
                - coalesce((select sum(c.amount) from public.credit_notes c
                             where c.tenant_id = v_tenant and c.invoice_id = i.id), 0)
                + coalesce((select sum(d.amount) from public.debit_notes d
                             where d.tenant_id = v_tenant and d.invoice_id = i.id), 0))
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                 join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant
                where cc.tenant_id = v_tenant and cc.source in ('overpayment', 'redeemed_split')  -- R-1614: + the used part of a split
                  and p.quote_id = q.id and p.status = 'received')
             /* R-1563: the excess a credit note left on this invoice now sits in a
                customer_credits row (source_invoice_id) — open: counted in (3); used: inside the
                payment that used it; refunded: paid out with its payment. Not here again. */
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                where cc.tenant_id = v_tenant and cc.source_invoice_id = i.id
                  and cc.status in ('open', 'used')))), 0)
        from public.quotes q
        join public.invoices i on i.id = q.invoice_id and i.tenant_id = v_tenant
       where q.tenant_id = v_tenant
         and i.status in ('pending', 'paid', 'overdue')
         and not exists (select 1 from public.invoices i2
                          where i2.tenant_id = v_tenant and i2.quote_id = q.id and i2.id <> i.id)
         and not exists (select 1 from public.project_milestones pm
                          where pm.tenant_id = v_tenant and pm.invoice_id = i.id))
   + (select coalesce(sum(cc.amount), 0)
        from public.customer_credits cc
       where cc.tenant_id = v_tenant and cc.status = 'open'))::bigint,
    -- Project receivable: har active/completed project ka max(0, invoiced milestones − received).
    (select coalesce(sum(greatest(0,
              coalesce((select sum(pm.total_amount) from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.project_id = ps.id and pm.invoice_id is not null), 0)
            - coalesce((select sum(pp.amount) from public.project_payments pp
                         where pp.tenant_id = v_tenant and pp.project_id = ps.id), 0))), 0)::bigint
       from public.project_sales ps
      where ps.tenant_id = v_tenant and ps.status in ('active', 'completed')),
    (select coalesce(sum(t.tds_amount), 0)::bigint
       from public.tds_receivable t
      where t.tenant_id = v_tenant and t.status in ('pending_cert', 'cert_received', 'verified_26as')),
    -- Employee loans: KUL principal − KUL repayments (per-loan max(0) nahi — purana TS bhi
    -- total par karta tha; parity ke liye waise hi).
    greatest(0,
      (select coalesce(sum(l.principal), 0) from public.employee_loans l where l.tenant_id = v_tenant)
    - (select coalesce(sum(r.amount), 0) from public.employee_loan_repayments r where r.tenant_id = v_tenant))::bigint,
    (select coalesce(sum(greatest(0, pa.total_amount - pa.consumed_amount)), 0)::bigint
       from public.prepaid_advances pa where pa.tenant_id = v_tenant),
    -- EMI purchase jo abhi fixed-asset register me nahi — cost par (register wale WDV par, TS me).
    (select coalesce(sum(ep.total_cost), 0)::bigint
       from public.emi_purchases ep
      where ep.tenant_id = v_tenant
        and not exists (select 1 from public.fixed_assets fa
                         where fa.tenant_id = v_tenant and fa.emi_purchase_id = ep.id)),
    greatest(0,
      (select coalesce(sum(ep.financed), 0) from public.emi_purchases ep where ep.tenant_id = v_tenant)
    - (select coalesce(sum(em.principal_part), 0) from public.emi_payments em where em.tenant_id = v_tenant))::bigint,
    greatest(0,
      (select coalesce(sum(bl.principal), 0) from public.business_loans bl where bl.tenant_id = v_tenant)
    - (select coalesce(sum(bp.principal_part), 0) from public.business_loan_payments bp where bp.tenant_id = v_tenant))::bigint,
    (select coalesce(sum(greatest(0, vb.total - vb.paid_amount)), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.status <> 'paid'),
    (select coalesce(sum(greatest(0, s.net - s.paid_amount)), 0)::bigint
       from public.salary_payments s where s.tenant_id = v_tenant and s.paid_status <> 'paid'),
    -- Statutory dues ke hisse (har booked salary, paid ho ya nahi; employer share bhi) —
    -- statutoryDues() TS me jodta hai, taaki Payroll banner aur ye ek hi niyam rahein.
    (select coalesce(sum(s.tds), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.pf + s.pf_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.esi + s.esi_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    -- R-1580: + TDS kaata partner commission par (194H) — credit (earned) hote hi sarkar ka
    -- dena, commission paid ho ya nahi; cancelled me kuch kaata nahi. Challan dues_paid me.
    ((select coalesce(sum(e.tds_amount), 0) from public.expenses e where e.tenant_id = v_tenant and e.tds_amount > 0)
   + (select coalesce(sum(rc.tds_amount), 0) from public.referral_commissions rc
       where rc.tenant_id = v_tenant and rc.tds_amount > 0 and rc.status <> 'cancelled')
    -- R-1891: 194Q TDS deducted when a COGS bill was paid from the bank.
   + (select coalesce(sum(l.tds_amount), 0) from public.bank_vendor_payment_lines l
       where l.tenant_id = v_tenant and l.kind in ('bill', 'new_bill') and l.tds_amount > 0)
    -- R-1849: TDS on partners' interest + remuneration (194T / 393(3)), owed from the year-end credit.
   + (select coalesce(sum(pl.tds), 0) from public.partner_appropriation_lines pl
       where pl.tenant_id = v_tenant and pl.tds > 0))::bigint,
    (select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'amount', d.amount) order by d.kind), '[]'::jsonb)
       from (select sd.kind, sum(sd.amount)::bigint as amount
               from public.statutory_dues_payments sd where sd.tenant_id = v_tenant group by sd.kind) d),
    (select coalesce(sum(r.amount), 0)::bigint
       from public.reimbursements r where r.tenant_id = v_tenant and r.status = 'pending'),
    -- GST CUMULATIVE (≤ as_of): frozen tax_amount, purani row me amount se reverse-derive
    -- (rate ?? 18), phir credit note ghatao, debit note jodo.
    ((select coalesce(sum(coalesce(i.tax_amount,
               floor(i.amount::numeric * coalesce(i.tax_rate, 18) / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint)), 0)
        from public.invoices i
       where i.tenant_id = v_tenant and i.invoice_date <= v_to and i.status in ('pending', 'paid', 'overdue')
         and public.invoice_is_sale(i.document_kind))  -- R-1739: no GST on an imported Zoho opening invoice
     - (select coalesce(sum(c.tax_amount), 0) from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date <= v_to)
     + (select coalesce(sum(d.tax_amount), 0) from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date <= v_to))::bigint,
    (select coalesce(sum(vb.cgst + vb.sgst + vb.igst), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.bill_date <= v_to),
    -- ITC: expense GST ko (bill_type, category, vendor GSTIN) par group karke — eligibility
    -- splitItc() TS me hi tay karta hai. Sirf gst_paid > 0 rows (splitItc 0 ko chhod deta hai).
    (select coalesce(jsonb_agg(jsonb_build_object('bill_type', g.bill_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'gst_paid', g.gst, 'n', g.n)), '[]'::jsonb)
       from (select e.bill_type, e.category, v.gstin, sum(e.gst_paid)::bigint as gst, count(*)::int as n
               from public.expenses e
               left join public.vendors v on v.id = e.vendor_id and v.tenant_id = v_tenant
              where e.tenant_id = v_tenant and e.expense_date <= v_to and e.gst_paid > 0
              group by e.bill_type, e.category, v.gstin) g),
    -- Fixed-asset register (chhoti table) — WDV bookValueNow() TS me.
    (select coalesce(jsonb_agg(jsonb_build_object('id', fa.id, 'name', fa.name, 'block', fa.block, 'cost', fa.cost,
                                                  'put_to_use', fa.put_to_use, 'disposed_on', fa.disposed_on,
                                                  'disposal_value', fa.disposal_value, 'emi_purchase_id', fa.emi_purchase_id)
                               order by fa.put_to_use, fa.id), '[]'::jsonb)
       from public.fixed_assets fa where fa.tenant_id = v_tenant),
    -- Tax challans (GST + income tax) — kind/period/fy par jode hue.
    (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'amount', t.amount, 'period', t.period, 'fy', t.fy)), '[]'::jsonb)
       from (select tp.kind, tp.period, tp.fy, sum(tp.amount)::bigint as amount
               from public.tax_payments tp where tp.tenant_id = v_tenant group by tp.kind, tp.period, tp.fy) t),
    -- S45-SLICE2 (G4): unpaid expenses — P&L me kharcha, ab tak koi payable nahi tha.
    -- amount − TDS (TDS dues_vendor_tds me pehle se). Bank line se match = paid, bahar.
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0)), 0)::bigint
       from public.expenses e
      where e.tenant_id = v_tenant and e.paid = false and e.reconciled_txn_id is null
        and e.expense_date <= v_to
        and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G2): "paid" expenses jinki koi bank line match nahi — cash / UPI jo bank
    -- me abhi dikha nahi. Paisa haath se gaya; undeposited funds ka aaina (cash ka ulta).
    -- Jinka Cr pehle se kahin hai wo bahar: payroll/statutory (salary payable + dues),
    -- reimbursement (reimbursements payable), emi (loan + apni bank line), advance
    -- (employee loan / prepaid), EXP-RZPFEE-* (undeposited se ghata).
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0)), 0)::bigint
       from public.expenses e
      where e.tenant_id = v_tenant and e.paid is distinct from false and e.reconciled_txn_id is null
        and e.expense_date <= v_to
        and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G3): salary se kaata "other" deduction — kharcha gross hai, net payable
    -- kam; ye raqam company ke paas rakhi hai (kisi ko dena / wapas). Pehle kahin nahi.
    (select coalesce(sum(s.other_deduction), 0)::bigint
       from public.salary_payments s where s.tenant_id = v_tenant),
    -- R-1576: bills ka GST bhi ITC niyam se (lib/gst/bill-itc.ts) — document_type, vendor GSTIN,
    -- heads (state check ke liye IGST / CGST+SGST alag group), category (s.17(5)). TS tay karta hai.
    (select coalesce(jsonb_agg(jsonb_build_object('document_type', g.document_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'cgst', g.cgst, 'sgst', g.sgst, 'igst', g.igst,
                                                  'n', g.n, 'ownStateCode', v_own_state)), '[]'::jsonb)
       from (select b.document_type, b.category, b.vendor_gstin as gstin,
                    sum(b.cgst)::bigint as cgst, sum(b.sgst)::bigint as sgst, sum(b.igst)::bigint as igst, count(*)::int as n
               from public.vendor_bills b
              where b.tenant_id = v_tenant and b.bill_date <= v_to and b.cgst + b.sgst + b.igst > 0
              group by b.document_type, b.category, b.vendor_gstin, (b.igst > 0), (b.cgst + b.sgst > 0)) g),
    -- R-1580: partner commission earned par abhi diya nahi — P&L me gross kharcha, yahan net
    -- deni-daari (TDS upar dues_vendor_tds me). pay_referral_commission status 'paid' karta hai.
    (select coalesce(sum(rc.net_payable), 0)::bigint
       from public.referral_commissions rc
      where rc.tenant_id = v_tenant and rc.status = 'earned');
end;
$function$;

revoke all on function public.report_balance_sheet(date) from public, anon;
grant execute on function public.report_balance_sheet(date) to authenticated, service_role;

commit;
