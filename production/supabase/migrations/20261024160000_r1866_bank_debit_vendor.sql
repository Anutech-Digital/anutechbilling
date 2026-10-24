-- deploy-peek: to_regclass('public.bank_vendor_payment_lines') is not null and to_regprocedure('public.bank_debit_vendor_open_items(uuid)') is not null and to_regprocedure('public.reconcile_bank_debit_to_vendor(uuid,uuid,jsonb,jsonb,jsonb,integer,text,integer,text)') is not null
-- deploy-key: r1866bankdebitvendor
-- 20261024160000_r1866_bank_debit_vendor.sql
--
-- R-1866 (24 Oct 2026, Pardeep): "vendor ki payment ka bhi poora system banao logical aur user
-- friendly jab reconcile se entry karte hai". The money-OUT counterpart of R-1838.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   A money-out bank line could settle ONE COGS bill (book_bank_txn_as_vendor_bill), and only
--   when the line was not bigger than the bill. A vendor's unpaid EXPENSE bills (expenses with
--   paid = false — rent, professional fees, contractors) had no bank path at all
--   (reconcile_expenses_to_bank_txn wants the lines to add up to the gross amounts, so a payment
--   net of TDS never fits). Two bills in one transfer, a part payment with TDS, a bill never
--   entered, an advance, a bank charge on the same line: all impossible, so the line was booked
--   as a plain expense (cost counted twice) or left unmatched.
--
-- ─── THE ACCOUNTING (no new money semantics) ────────────────────────────────
--   COGS bill (vendor_bills):   paid_amount += what this line settles; status unpaid / partial /
--                               paid — exactly what pay_vendor_bill / mark_payment_run_paid do.
--                               TDS on a COGS bill is NOT taken here: vendor_bills has no TDS
--                               column and 26Q / TDS payable read expenses only (card R-1868).
--   Expense bill (expenses):    paid in full; the TDS on it (already on the row, or recorded now
--                               as tds_section / tds_amount) is the existing 26Q + "TDS payable"
--                               (report_balance_sheet.dues_vendor_tds) source. Bank = amount − TDS.
--                               paid = true, paid_date = bank date, reconciled_txn_id = this line
--                               → it leaves "expenses payable" (S45 G4) exactly like a matched one.
--   New bill on the spot:       a COGS bill (vendor_bills row, as Add COGS Bill inserts it; input
--                               credit yes = tax_invoice, no = other → R-1576 makes its GST a cost)
--                               or an expense (bill_type gst = input credit, none = GST is cost —
--                               lib/gst/itc.ts), recorded AND paid in this one transaction.
--   Advance to the vendor:      prepaid_advances row (the existing Prepaid asset). A later bill is
--                               adjusted against it by the existing Prepaid → Book invoice
--                               (consume_prepaid_fifo). Extra money over the bills = advance too.
--   Bank charge:                its own expense row, category Bank Charges.
--   The cash legs must add up to the bank debit to the rupee, or nothing is written.
--
-- ─── THE DATA ───────────────────────────────────────────────────────────────
--   bank_vendor_payment_lines — what ONE bank line paid: one row per bill / expense / new bill /
--   advance / bank charge, with the cash, the TDS and (for an existing expense) its values before,
--   so un-reconciling the line puts every document back exactly (trigger below). The line itself
--   is matched_to_type 'vendor_payment', matched_to_id = the vendor.
--   vendors.default_tds_section — the vendor's usual TDS section (194C / 194J / …), pre-filled.
--   Stored data is not changed: no existing row is rewritten.
--
-- Guards: §17c fail-closed tenant check, R-718 money roles (owner / manager / accountant / billing).
-- Test: supabase/tests/r1866_bank_debit_vendor.test.sql

begin;

-- ── 1. Vendor's usual TDS section ──────────────────────────────────────────
alter table public.vendors add column if not exists default_tds_section text;
alter table public.vendors drop constraint if exists vendors_default_tds_section_shape;
alter table public.vendors add constraint vendors_default_tds_section_shape
  check (default_tds_section is null or default_tds_section ~ '^19[0-9]{1,2}[A-Z]{0,2}$');
comment on column public.vendors.default_tds_section is
  'R-1866: the TDS section usually deducted on this vendor (194C / 194J / 194H / 194I / 194Q …). Rates live in lib/accounting/tds-rates.ts.';

-- ── 2. A bank line can be a vendor payment ──────────────────────────────────
-- Added to whatever the check holds now (other cards add their own types), never a fixed list.
do $$
declare v_def text; v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.bank_transactions'::regclass and c.conname = 'bank_transactions_matched_to_type_check';
  if v_def is null or position('''vendor_payment''' in v_def) > 0 then
    if v_def is null then raise exception 'bank_transactions_matched_to_type_check is missing'; end if;
    return;
  end if;
  select array_agg(m[1] order by ord) into v_vals
    from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  v_vals := array_append(v_vals, 'vendor_payment'::text);
  execute 'alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check';
  execute format('alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check check (matched_to_type = any (%L::text[]))', v_vals);
end $$;

-- ── 3. What one bank line paid ──────────────────────────────────────────────
create table if not exists public.bank_vendor_payment_lines (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references public.tenants(id) on delete cascade,
  bank_txn_id        uuid        not null references public.bank_transactions(id) on delete restrict,
  vendor_id          uuid        references public.vendors(id) on delete set null,
  kind               text        not null check (kind in ('bill', 'expense', 'new_bill', 'new_expense', 'advance', 'bank_charge')),
  vendor_bill_id     text        references public.vendor_bills(id) on delete restrict,
  expense_id         text        references public.expenses(id) on delete restrict,
  prepaid_advance_id uuid        references public.prepaid_advances(id) on delete restrict,
  -- Cash from the bank for this row (whole rupees). All rows of a line add up to its debit.
  cash               integer     not null check (cash >= 0),
  -- TDS withheld on this row (expenses only — the 26Q source); the document is settled by cash + tds.
  tds_amount         integer     not null default 0 check (tds_amount >= 0),
  tds_section        text,
  -- An existing expense's values before this payment, to put back on un-reconcile.
  prev               jsonb,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  check (num_nonnulls(vendor_bill_id, expense_id, prepaid_advance_id) = 1),
  check ((kind in ('bill', 'new_bill')) = (vendor_bill_id is not null)),
  check ((kind = 'advance') = (prepaid_advance_id is not null)),
  check (tds_amount = 0 or (kind in ('expense', 'new_expense') and tds_section is not null))
);

comment on table public.bank_vendor_payment_lines is
  'R-1866: what one money-out bank line (matched_to_type vendor_payment) paid — bills, expense bills, a new bill, an advance, a bank charge. Written only by reconcile_bank_debit_to_vendor; un-reconciling the line reverses every row.';

create index if not exists bank_vendor_payment_lines_txn_idx on public.bank_vendor_payment_lines (bank_txn_id);
create index if not exists bank_vendor_payment_lines_vendor_idx on public.bank_vendor_payment_lines (tenant_id, vendor_id);
create index if not exists bank_vendor_payment_lines_bill_idx on public.bank_vendor_payment_lines (vendor_bill_id) where vendor_bill_id is not null;
create index if not exists bank_vendor_payment_lines_exp_idx on public.bank_vendor_payment_lines (expense_id) where expense_id is not null;
create index if not exists bank_vendor_payment_lines_adv_idx on public.bank_vendor_payment_lines (prepaid_advance_id) where prepaid_advance_id is not null;

alter table public.bank_vendor_payment_lines enable row level security;
drop policy if exists "tenant isolation read" on public.bank_vendor_payment_lines;
drop policy if exists zzz_service_role_all on public.bank_vendor_payment_lines;
-- Reads: same company AND a money role. Writes only through the functions below.
create policy "tenant isolation read" on public.bank_vendor_payment_lines for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant', 'billing')));
-- Cloud SQL has no BYPASSRLS: the service role needs its own policy.
create policy zzz_service_role_all on public.bank_vendor_payment_lines as permissive for all to service_role
  using (true) with check (true);
grant select on public.bank_vendor_payment_lines to authenticated;
grant select, insert, update, delete on public.bank_vendor_payment_lines to service_role;

-- ── 4. A vendor's open bills ────────────────────────────────────────────────
create or replace function public.bank_debit_vendor_open_items(p_vendor_id uuid)
returns table (
  source      text,      -- vendor_bill (COGS bill) | expense (unpaid expense bill)
  doc_id      text,
  bill_no     text,
  doc_date    date,
  due_date    date,
  category    text,
  total       integer,   -- the document's gross total
  amount_due  integer,   -- still owed, gross (before TDS)
  gst         integer,
  tds_base    integer,   -- value before GST (the TDS base)
  tds_amount  integer,   -- TDS already on the expense row (0 for a COGS bill)
  tds_section text,
  can_part    boolean,   -- a COGS bill can be part-paid; an expense bill is paid in full
  in_run      text       -- an open payment run that holds it (pay it there, or cancel the run)
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
  /* R-1866 / §17c: fail closed for a login with no company. */
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
  select 'vendor_bill'::text, b.id, b.bill_no, b.bill_date, b.due_date, b.category,
         b.total, greatest(0, b.total - coalesce(b.paid_amount, 0)),
         (b.cgst + b.sgst + b.igst), b.subtotal, 0, null::text, true,
         (select pr.run_no from public.payment_run_items it join public.payment_runs pr on pr.id = it.run_id
           where it.tenant_id = b.tenant_id and it.source = 'vendor_bill' and it.doc_id = b.id
             and pr.status in ('draft', 'approved') limit 1)
    from public.vendor_bills b
   where b.tenant_id = v_vendor.tenant_id
     and (b.vendor_id = v_vendor.id or (b.vendor_id is null and upper(trim(b.vendor_name)) = upper(trim(v_vendor.name))))
     and coalesce(b.status, 'unpaid') <> 'paid'
     and upper(coalesce(b.currency, 'INR')) = 'INR'
     and b.total - coalesce(b.paid_amount, 0) > 0
  union all
  select 'expense'::text, e.id, e.bill_no, e.expense_date, e.due_date, e.category,
         e.amount, e.amount, coalesce(e.gst_paid, 0), greatest(0, e.amount - coalesce(e.gst_paid, 0)),
         coalesce(e.tds_amount, 0), e.tds_section, false,
         (select pr.run_no from public.payment_run_items it join public.payment_runs pr on pr.id = it.run_id
           where it.tenant_id = e.tenant_id and it.source = 'expense' and it.doc_id = e.id
             and pr.status in ('draft', 'approved') limit 1)
    from public.expenses e
   where e.tenant_id = v_vendor.tenant_id
     and (e.vendor_id = v_vendor.id or (e.vendor_id is null and upper(trim(coalesce(e.vendor_name, ''))) = upper(trim(v_vendor.name))))
     and e.paid = false and e.reconciled_txn_id is null
     and upper(coalesce(e.currency, 'INR')) = 'INR'
     and e.category <> 'Salaries'
     and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
     and e.prepaid_advance_id is null
     and e.amount > 0
   order by 4, 2;
end;
$$;

revoke all on function public.bank_debit_vendor_open_items(uuid) from public, anon;
grant execute on function public.bank_debit_vendor_open_items(uuid) to authenticated, service_role;

-- ── 5. Pay a vendor from a money-out bank line — ONE transaction ────────────
--   p_vendor_id   the vendor, or NULL with p_new_vendor {name, gstin, pan, tds_section}
--                 (an existing vendor of the same GSTIN / name is used instead of a duplicate)
--   p_items       [{source: vendor_bill|expense, doc_id, amount (settled, gross), tds_amount, tds_section}]
--   p_new_bill    {kind: cogs|expense, bill_no, bill_date, due_date, category, taxable, gst, itc,
--                  tds_amount, tds_section, pay (gross settled; COGS may be part, expense in full)}
--   p_advance     extra / advance to the vendor (prepaid asset), p_advance_category its expense category
--   p_bank_charge bank's own charge on the line (expense, Bank Charges)
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

  /* ── (a) Open bills ── */
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_src := it->>'source';
    v_doc := it->>'doc_id';
    v_amt := round(coalesce((it->>'amount')::numeric, 0))::integer;
    v_tds := round(coalesce((it->>'tds_amount')::numeric, 0))::integer;
    v_sec := nullif(upper(trim(coalesce(it->>'tds_section', ''))), '');
    if v_src not in ('vendor_bill', 'expense') or v_doc is null then raise exception 'Bad bill in the list' using errcode = '22023'; end if;
    if v_src || ':' || v_doc = any (v_seen) then raise exception '% is in the list twice', v_doc using errcode = '22023'; end if;
    v_seen := v_seen || (v_src || ':' || v_doc);
    if v_amt <= 0 then raise exception 'Amount for % must be more than zero', v_doc using errcode = '22023'; end if;
    if v_tds < 0 then raise exception 'TDS cannot be negative' using errcode = '22023'; end if;

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
      if v_tds > 0 then
        raise exception 'TDS on a COGS bill (%) cannot be recorded from the bank yet — pay the bill amount, and record the TDS with your CA.', coalesce(v_bill.bill_no, v_doc)
          using errcode = '22023';
      end if;
      v_out := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
      if v_bill.status = 'paid' or v_out <= 0 then raise exception 'Bill % is already paid', coalesce(v_bill.bill_no, v_doc) using errcode = 'check_violation'; end if;
      if v_amt > v_out then
        raise exception 'Bill %: ₹% is more than the ₹% still owed — put the extra as an advance.', coalesce(v_bill.bill_no, v_doc), v_amt, v_out using errcode = '22023';
      end if;
      -- Same settlement as pay_vendor_bill / mark_payment_run_paid.
      update public.vendor_bills
         set paid_amount = coalesce(paid_amount, 0) + v_amt,
             status = case when coalesce(paid_amount, 0) + v_amt >= coalesce(total, 0) then 'paid' else 'partial' end,
             updated_at = now()
       where id = v_doc
       returning status into v_status;
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'bill', v_doc, v_amt, v_uid);
      v_cash := v_cash + v_amt;
      v_paid := v_paid || jsonb_build_object('source', 'vendor_bill', 'doc_id', v_doc, 'bill_no', v_bill.bill_no,
                 'settled', v_amt, 'cash', v_amt, 'tds', 0, 'tds_section', null, 'status', v_status,
                 'still_due', v_out - v_amt);
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
      if v_amt <> v_exp.amount then
        raise exception 'Expense bill % is paid in full (₹%), not ₹%. For a part payment, book the money as an advance.', coalesce(v_exp.bill_no, v_doc), v_exp.amount, v_amt
          using errcode = '22023';
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
        raise exception 'TDS on a COGS bill cannot be recorded from the bank yet — record it as an expense bill, or without TDS.' using errcode = '22023';
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

-- ── 6. Un-reconcile puts every document back ────────────────────────────────
create or replace function public.tg_vendor_payment_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r   public.bank_vendor_payment_lines;
  v_used integer;
begin
  if old.matched_to_type = 'vendor_payment'
     and (new.matched_to_type is distinct from 'vendor_payment' or new.matched_to_id is distinct from old.matched_to_id) then
    for r in select * from public.bank_vendor_payment_lines where bank_txn_id = old.id order by created_at, id loop
      delete from public.bank_vendor_payment_lines where id = r.id;
      if r.kind = 'bill' then
        update public.vendor_bills
           set paid_amount = greatest(0, coalesce(paid_amount, 0) - r.cash),
               status = case when coalesce(paid_amount, 0) - r.cash <= 0 then 'unpaid'
                             when coalesce(paid_amount, 0) - r.cash < coalesce(total, 0) then 'partial' else 'paid' end,
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
        delete from public.vendor_bills where id = r.vendor_bill_id;
      elsif r.kind in ('new_expense', 'bank_charge') then
        delete from public.expenses where id = r.expense_id;
      elsif r.kind = 'advance' then
        select consumed_amount into v_used from public.prepaid_advances where id = r.prepaid_advance_id;
        if coalesce(v_used, 0) > 0 then
          raise exception 'This payment''s advance to the vendor has ₹% already used against bills. Delete those bills from the Prepaid page first, then un-reconcile.', v_used
            using errcode = 'check_violation';
        end if;
        delete from public.prepaid_advances where id = r.prepaid_advance_id;
      end if;
    end loop;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_vendor_payment_line_unmatched() from public, anon;

drop trigger if exists trg_vendor_payment_line_unmatched on public.bank_transactions;
create trigger trg_vendor_payment_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_vendor_payment_line_unmatched();

-- ── 7. A bill / expense paid by a vendor-payment line cannot be deleted under it ──
-- Same message and link as a line matched to it directly (delete_vendor_bill, delete_expense,
-- the no-orphan triggers all ask this function).
create or replace function public.matched_bank_line_blocker(p_tenant uuid, p_type text, p_id text, OUT o_msg text, OUT o_href text)
 returns record
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  t record;
begin
  select bt.txn_date, greatest(bt.debit, bt.credit) as amt, bt.description, bt.bank_account_id
    into t
    from public.bank_transactions bt
   where bt.tenant_id = p_tenant and bt.matched_to_type = p_type and bt.matched_to_id = p_id
   order by bt.txn_date limit 1;
  if not found and p_type in ('vendor_bill', 'expense') then
    /* R-1866: paid by a vendor-payment line (one line, several bills). */
    select bt.txn_date, greatest(bt.debit, bt.credit) as amt, bt.description, bt.bank_account_id
      into t
      from public.bank_vendor_payment_lines l
      join public.bank_transactions bt on bt.id = l.bank_txn_id
     where l.tenant_id = p_tenant
       and ((p_type = 'vendor_bill' and l.vendor_bill_id = p_id) or (p_type = 'expense' and l.expense_id = p_id))
     order by bt.txn_date limit 1;
  end if;
  if found then
    o_msg := format('Ye %s bank line (%s · ₹%s · %s) se match hai — delete karne par wo line ''reconciled'' reh jaati aur paisa kisi kharche me nahi dikhta. Pehle Banking me us line par Un-reconcile dabao, phir ye %s delete karo.',
      case p_type when 'vendor_bill' then 'bill' else 'kharcha' end,
      to_char(t.txn_date, 'DD Mon YYYY'), t.amt, left(coalesce(t.description, ''), 60),
      case p_type when 'vendor_bill' then 'bill' else 'kharcha' end);
    o_href := '/accounting/banking/' || t.bank_account_id::text;
  end if;
end;
$function$;

commit;
