-- deploy-peek: to_regclass('public.zoho_purchase_vendor_changes') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendor_bills' and column_name = 'zoho_tds_amount') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'zoho_import_sig') and to_regprocedure('public._r2502_category_allowed(text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_purchases(text,text,jsonb,boolean)') and prosrc like '%R-2502c%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_vendor_payments(text,jsonb,boolean)') and prosrc like '%R-2502c%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.remove_zoho_fy_purchase_import(uuid,text)') and prosrc like '%R-2502c%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_debit_vendor_open_items(uuid)') and prosrc like '%R-2502c%')
-- deploy-key: r2502cimportreviewfixes
--
-- R-2502c (independent review BLOCK, 5 Nov 2026 — card R-2502 independentReview v12): fixes before
-- the first real FY 2025-26 purchase import. Functions taken from their LATEST bodies (checked on all
-- anutech/* branches): import_zoho_fy_purchases / import_zoho_fy_vendor_payments / remove_ /
-- save_zoho_account_categories / tg_purchases_zoho_doc_guard ← 20261105172700 + 20261105183000;
-- bank_debit_vendor_open_items ← 20261025174159_r1915 (only the COGS-bill row changes).
--
--   1. Category whitelist in SQL (_r2502_category_allowed — the same list as purchase-import/plan.ts
--      CATEGORY_CHOICES; a vitest keeps them equal): no special category ("Employee advance", any
--      free "COGS-*", "salaries"), case-sensitive.
--   2. Vendor: a name match only when the app vendor has no GSTIN or the same one — never a vendor
--      with another GSTIN (a new vendor is made). A picked vendor with another GSTIN is refused.
--      Zoho contact id / GSTIN are only FILLED when empty, never overwritten, and every vendor the
--      import made or filled is written to zoho_purchase_vendor_changes — undo reverses it.
--   3. Vendor payments on an expense bill: booked ("paid", no bank line) ONLY when exactly one Zoho
--      payment covers the bill with its TDS — that payment then matches one bank debit (recorded
--      payment). A bill Zoho paid in 2+ payments, or partly, is never marked paid with one date:
--      every payment is listed (to_reconcile) and paid in Reconcile on its own debit — the R-1915
--      expense part-payment path (TDS with the first part).
--   4. COGS bill TDS in real fields: vendor_bills.zoho_tds_amount / zoho_tds_section; Reconcile's
--      open COGS-bill item pre-fills them (bank_debit_vendor_open_items) while no TDS was taken on
--      the bill yet. The import result lists each COGS payment with its TDS.
--   5. Duplicate check every time: the same vendor (or GSTIN) + date ±3 days + amount (±₹1) already
--      in the books without a Zoho id → refused with the reason (plus the old same-number check).
--   6. TDS on a multi-category bill is spread over its rows by taxable value (the 26Q base of each
--      row is then right), not all on the first row.
--   7. A Zoho expense is booked against the app account its paid-through account maps to (the
--      owner's map or the receipts-import suggestion): cash → payment_method cash + the petty-cash
--      line (as Add expense does); credit card → card; else bank (banked by Reconcile). No account
--      → not imported, listed. Never a blank payment method. The same for a vendor payment that
--      marks an expense bill paid.
--   8. Undo refuses rows edited after the import (zoho_import_sig), deletes the import's own petty-
--      cash lines, and reverses the vendor fields the import set.
--
-- Cloud SQL: no extensions schema; auth.uid() rewritten by the deploy script. Grants explicit.
-- Test: supabase/tests/r2502_zoho_fy_purchase_import.test.sql (red without this file).
-- Rollback: re-run sections 4-7 of 20261105172700 + 20261105183000 and bank_debit_vendor_open_items
--   from 20261025174159; drop _r2502_category_allowed, _r2502_expense_sig, _r2502_bill_sig,
--   zoho_purchase_vendor_changes and the four new columns (after removing every batch).

begin;

-- ── 1. Whitelist ─────────────────────────────────────────────────────────────────────────────
create or replace function public._r2502_category_allowed(p_category text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  /* R-2502c — EXACTLY purchase-import/plan.ts CATEGORY_CHOICES (vitest r2502c-category-list keeps them equal). */
  select p_category = any (array[
    'Hosting', 'Software', 'Director''s Remuneration', 'Office Rent', 'Marketing', 'Advertising',
    'Business Promotion', 'Staff Welfare', 'Travel', 'Professional Services', 'Commission / Incentive (agents)',
    'Bank Charges', 'Internet & Phone', 'Utilities', 'Office Supplies', 'Equipment', 'Repairs & Maintenance',
    'Insurance', 'Rates & Taxes', 'Interest on loans / OD', 'Exchange gain / loss (realised)', 'Other',
    'COGS-Workspace', 'COGS-M365', 'COGS-Zoho', 'COGS-Other']);
$function$;
revoke all on function public._r2502_category_allowed(text) from public, anon;
grant execute on function public._r2502_category_allowed(text) to authenticated, service_role;

create or replace function public.save_zoho_account_categories(p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 — R-2502c: only the whitelist (_r2502_category_allowed) */
  v_tenant uuid := public.current_tenant_id();
  r        jsonb;
  v_id     text;
  v_cat    text;
  v_set    integer := 0;
  v_clear  integer := 0;
begin
  if v_tenant is null then
    raise exception 'Saving the account map needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can map Zoho accounts.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Send at most 500 accounts.' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_id  := btrim(coalesce(r->>'zoho_account_id', ''));
    v_cat := btrim(coalesce(r->>'category', ''));
    if v_id = '' or char_length(v_id) > 40 then
      raise exception 'A Zoho account id is missing.' using errcode = '22023';
    end if;
    if v_cat = '' then
      delete from public.zoho_account_category_map where tenant_id = v_tenant and zoho_account_id = v_id;
      v_clear := v_clear + 1;
      continue;
    end if;
    if not public._r2502_category_allowed(v_cat) then
      raise exception '"%" is not a category a Zoho account can be mapped to (Salaries go through Payroll; COGS only as COGS-Workspace / M365 / Zoho / Other).', left(v_cat, 60)
        using errcode = '22023';
    end if;
    insert into public.zoho_account_category_map (tenant_id, zoho_account_id, zoho_account_name, category, updated_by, updated_at)
    values (v_tenant, v_id, left(btrim(coalesce(r->>'zoho_account_name', '')), 200), v_cat, auth.uid(), now())
    on conflict (tenant_id, zoho_account_id) do update
      set category = excluded.category, zoho_account_name = excluded.zoho_account_name, updated_by = excluded.updated_by, updated_at = now();
    v_set := v_set + 1;
  end loop;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_account_map.saved', 'zoho_account_category_map', null,
          left(format('Zoho account map: %s set, %s cleared', v_set, v_clear), 120), jsonb_build_object('rows', p_rows));
  return jsonb_build_object('saved', v_set, 'cleared', v_clear);
end;
$function$;
revoke all on function public.save_zoho_account_categories(jsonb) from public, anon;
grant execute on function public.save_zoho_account_categories(jsonb) to authenticated, service_role;

-- ── 2. New fields ────────────────────────────────────────────────────────────────────────────
alter table public.vendor_bills add column if not exists zoho_tds_amount integer not null default 0;
alter table public.vendor_bills add column if not exists zoho_tds_section text;
alter table public.vendor_bills add column if not exists zoho_import_sig text;
alter table public.expenses add column if not exists zoho_import_sig text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vendor_bills_zoho_tds_shape') then
    alter table public.vendor_bills add constraint vendor_bills_zoho_tds_shape check (
      zoho_tds_amount >= 0
      and (zoho_tds_amount = 0) = (zoho_tds_section is null)
      and (zoho_tds_section is null or zoho_tds_section ~ '^19[0-9]{1,2}[A-Z]{0,2}$'));
  end if;
end $$;
comment on column public.vendor_bills.zoho_tds_amount is
  'R-2502c: TDS Zoho deducted on this imported COGS bill — not booked yet; Reconcile pre-fills it on the bill''s first payment (bank_debit_vendor_open_items). 0 on every other bill.';
comment on column public.vendor_bills.zoho_tds_section is 'R-2502c: the section of zoho_tds_amount (app code, e.g. 194C, 194JB).';
comment on column public.expenses.zoho_import_sig is 'R-2502c: fingerprint of the row as the Zoho import wrote it — undo refuses a row edited since.';
comment on column public.vendor_bills.zoho_import_sig is 'R-2502c: fingerprint of the row as the Zoho import wrote it — undo refuses a row edited since.';

create or replace function public._r2502_expense_sig(e public.expenses)
returns text
language sql
stable
set search_path to 'public'
as $function$
  /* R-2502c: what an edit would change (not the paid fields — a payment is not an edit). */
  select md5(concat_ws('|', e.amount, e.gst_paid, e.igst, e.cgst, e.sgst, e.category, e.vendor_id, e.expense_date, e.due_date,
                       e.tds_amount, e.tds_section, e.bill_no, e.rcm, e.rcm_tax, e.bill_type));
$function$;
create or replace function public._r2502_bill_sig(b public.vendor_bills)
returns text
language sql
stable
set search_path to 'public'
as $function$
  /* R-2502c */
  select md5(concat_ws('|', b.total, b.subtotal, b.cgst, b.sgst, b.igst, b.category, b.vendor_id, b.bill_date, b.due_date,
                       b.bill_no, b.document_type, b.zoho_tds_amount, b.zoho_tds_section));
$function$;
revoke all on function public._r2502_expense_sig(public.expenses) from public, anon;
revoke all on function public._r2502_bill_sig(public.vendor_bills) from public, anon;
grant execute on function public._r2502_expense_sig(public.expenses) to authenticated, service_role;
grant execute on function public._r2502_bill_sig(public.vendor_bills) to authenticated, service_role;

create table if not exists public.zoho_purchase_vendor_changes (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  batch_id            uuid        not null references public.zoho_fy_import_batches(id) on delete restrict,
  vendor_id           uuid        not null,
  created             boolean     not null default false,
  set_zoho_contact_id text,
  set_gstin           text,
  created_at          timestamptz not null default now()
);
comment on table public.zoho_purchase_vendor_changes is
  'R-2502c: every vendor the FY purchase import made, or whose empty Zoho contact id / GSTIN it filled — remove_zoho_fy_purchase_import reverses them.';
create index if not exists zoho_purchase_vendor_changes_batch_idx on public.zoho_purchase_vendor_changes (batch_id);
alter table public.zoho_purchase_vendor_changes enable row level security;
revoke all on table public.zoho_purchase_vendor_changes from public, anon, authenticated;
grant select on table public.zoho_purchase_vendor_changes to authenticated;
grant all on table public.zoho_purchase_vendor_changes to service_role;
drop policy if exists zoho_purchase_vendor_changes_select on public.zoho_purchase_vendor_changes;
create policy zoho_purchase_vendor_changes_select on public.zoho_purchase_vendor_changes as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));
drop policy if exists zzz_service_role_all on public.zoho_purchase_vendor_changes;
create policy zzz_service_role_all on public.zoho_purchase_vendor_changes as permissive for all to service_role using (true) with check (true);

-- ── 3. Guard: the Zoho fields are the import's own ───────────────────────────────────────────
create or replace function public.tg_purchases_zoho_doc_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  n jsonb := to_jsonb(new);
  o jsonb;
begin
  /* R-2502 — R-2502c: also the import fingerprint and (bills) the Zoho TDS; the import itself may write them. */
  if coalesce(current_setting('app.zoho_purchase_import', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if n->>'zoho_doc_id' is not null or n->>'purchase_import_batch_id' is not null or n->>'zoho_import_sig' is not null
       or coalesce((n->>'zoho_tds_amount')::integer, 0) <> 0 or n->>'zoho_tds_section' is not null then
      raise exception 'A purchase from Zoho can only be added by Expenses → FY 2025-26 purchases from Zoho.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  o := to_jsonb(old);
  if n->'zoho_doc_id' is distinct from o->'zoho_doc_id' or n->'zoho_leg' is distinct from o->'zoho_leg'
     or n->'purchase_import_batch_id' is distinct from o->'purchase_import_batch_id'
     or n->'zoho_import_sig' is distinct from o->'zoho_import_sig'
     or n->'zoho_tds_amount' is distinct from o->'zoho_tds_amount' or n->'zoho_tds_section' is distinct from o->'zoho_tds_section' then
    raise exception '%: which Zoho document it came from cannot be changed.', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke all on function public.tg_purchases_zoho_doc_guard() from public, anon, authenticated;
drop trigger if exists trg_vendor_bills_zoho_doc_guard on public.vendor_bills;
create trigger trg_vendor_bills_zoho_doc_guard
  before insert or update of zoho_doc_id, purchase_import_batch_id, zoho_import_sig, zoho_tds_amount, zoho_tds_section on public.vendor_bills
  for each row execute function public.tg_purchases_zoho_doc_guard();
drop trigger if exists trg_expenses_zoho_doc_guard on public.expenses;
create trigger trg_expenses_zoho_doc_guard
  before insert or update of zoho_doc_id, zoho_leg, purchase_import_batch_id, zoho_import_sig on public.expenses
  for each row execute function public.tg_purchases_zoho_doc_guard();

-- ── 4. Reconcile's open items (← 20261025174159_r1915) ─────────────────────────────────────
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
  can_part    boolean,   -- R-1915: a COGS bill and an expense bill can both be part-paid
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
  /* R-1866 / §17c: fail closed for a login with no company. R-1911: recorded payments added. R-1913: less the advance applied. R-1915: expense bills part-paid. — R-2502c: COGS bill pre-fills its Zoho TDS. */
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
           -- R-1915: less the cash its bank parts already paid (the rest was marked paid).
           e.amount, e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0),
           coalesce(e.gst_paid, 0), greatest(0, e.amount - coalesce(e.gst_paid, 0)),
           0, null::text, false, null::text, coalesce(e.paid_date, e.expense_date), 'expense'::text, e.id
      from public.expenses e
     where e.tenant_id = v_vendor.tenant_id
       and (e.vendor_id = v_vendor.id or (e.vendor_id is null and upper(trim(coalesce(e.vendor_name, ''))) = upper(trim(v_vendor.name))))
       and e.paid = true and e.reconciled_txn_id is null
       and upper(coalesce(e.currency, 'INR')) = 'INR'
       and e.category <> 'Salaries'
       and lower(coalesce(e.payment_method, '')) not in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
       and e.prepaid_advance_id is null
       and e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
       and not exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id and l.kind = 'recorded_payment')
    union all
    select 'vendor_bill'::text, b.id, b.bill_no, b.bill_date, b.due_date, b.category,
           b.total, greatest(0, b.total - coalesce(b.paid_amount, 0)),
           (b.cgst + b.sgst + b.igst), b.subtotal,
           -- R-2502c: an imported Zoho bill's TDS, pre-filled on its first payment (none taken yet).
           case when coalesce(b.paid_amount, 0) = 0 and not exists (select 1 from public.bank_vendor_payment_lines l where l.vendor_bill_id = b.id and l.tds_amount > 0)
                then coalesce(b.zoho_tds_amount, 0) else 0 end,
           case when coalesce(b.paid_amount, 0) = 0 and coalesce(b.zoho_tds_amount, 0) > 0
                 and not exists (select 1 from public.bank_vendor_payment_lines l where l.vendor_bill_id = b.id and l.tds_amount > 0)
                then b.zoho_tds_section end,
           true,
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
           -- R-1915: amount_due is gross (before the TDS still to take). Not part-paid yet: the bill
           -- less the advance, its TDS still to withhold. Part-paid: the bill's whole TDS went with
           -- the first part, so the cash rest is due and no TDS is left to take (base 0).
           e.amount, e.amount - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0)
                     - case when coalesce(e.paid_amount, 0) > 0 then coalesce(e.tds_amount, 0) else 0 end,
           coalesce(e.gst_paid, 0),
           case when coalesce(e.paid_amount, 0) > 0 then 0 else greatest(0, e.amount - coalesce(e.gst_paid, 0)) end,
           case when coalesce(e.paid_amount, 0) > 0 then 0 else coalesce(e.tds_amount, 0) end, e.tds_section, true,
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
       and e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
  ) as x(c_source, c_doc_id, c_bill_no, c_doc_date, c_due_date, c_category, c_total, c_amount_due, c_gst, c_tds_base,
         c_tds_amount, c_tds_section, c_can_part, c_in_run, c_paid_on, c_pays_source, c_pays_doc_id)
  order by (x.c_source = 'recorded_payment') desc, x.c_doc_date, x.c_doc_id;
end;
$$;
revoke all on function public.bank_debit_vendor_open_items(uuid) from public, anon;
grant execute on function public.bank_debit_vendor_open_items(uuid) to authenticated, service_role;


-- ── 5a. Paid-from helper + vendor payments (R-2502c) ─────────────────────────────────────────────────────────────
-- Marks an app expense row paid from an app account: cash → its petty-cash line (as Add expense);
-- card / bank → the method + account, no line (Reconcile banks it from that account's statement).
create or replace function public._r2502_mark_paid(p_ids text[], p_on date, p_account public.bank_accounts)
returns void
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502c */
  e     public.expenses;
  v_txn uuid;
begin
  for e in select * from public.expenses where id = any (p_ids) order by zoho_leg, id loop
    update public.expenses
       set paid = true, paid_date = p_on, bank_account_id = p_account.id,
           payment_method = case when p_account.account_type = 'cash' then 'cash'
                                 when p_account.account_type = 'credit_card' then 'card' else 'bank' end
     where id = e.id;
    if p_account.account_type = 'cash' and e.amount - coalesce(e.tds_amount, 0) > 0 then
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
                                            matched_to_type, matched_to_id, match_confidence)
      values (e.tenant_id, p_account.id, p_on,
              left('Zoho FY import · petty cash: ' || e.category || coalesce(' · ' || e.vendor_name, ''), 300),
              e.amount - coalesce(e.tds_amount, 0), 0, 'manual', 'expense', e.id, 'manual')
      returning id into v_txn;
      update public.expenses set reconciled_txn_id = v_txn where id = e.id;
    end if;
  end loop;
end;
$function$;
revoke all on function public._r2502_mark_paid(text[], date, public.bank_accounts) from public, anon, authenticated;
grant execute on function public._r2502_mark_paid(text[], date, public.bank_accounts) to service_role;

create or replace function public.import_zoho_fy_vendor_payments(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 — R-2502c: an expense bill is booked only when ONE Zoho payment covers it (else listed,
     paid part by part in Reconcile); paid from the mapped app account; COGS bills listed with TDS. */
  v_tenant   uuid := public.current_tenant_id();
  v_start    date;
  v_lock     date;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_a        jsonb;
  v_zid      text;
  v_num      text;
  v_date     date;
  v_reason   text;
  v_acct     public.bank_accounts;
  v_bill     public.vendor_bills;
  v_first    text;
  v_npays    integer;
  v_amt      integer;
  v_owed     integer;
  v_tds      integer;
  v_exp_ids  text[];
  v_prev     jsonb;
  v_booked   integer;
  v_listed   integer;
  v_list_p   jsonb;
  v_amt_p    bigint;
  v_seen     text[] := array[]::text[];
  v_skipped  jsonb := '[]'::jsonb;
  v_list     jsonb := '[]'::jsonb;
  v_adv      jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_n        integer := 0;
  v_sum_amt  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing payments needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY vendor payments from Zoho.' using errcode = '42501';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$' or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There is nothing to import. Preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many payments in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;
  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, 'vendorpayments', p_fy, auth.uid())
  returning id into v_batch;

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_id', ''));
    v_reason := null; v_num := v_zid; v_scan := null; v_acct := null;
    if v_zid = '' or v_zid = any (v_seen) then
      v_reason := 'Listed twice or with no Zoho id.';
    else
      v_seen := v_seen || v_zid;
      select * into v_scan from public.zoho_fy_scan s
       where s.tenant_id = v_tenant and s.kind = 'vendorpayments' and s.zoho_id = v_zid and s.fy = p_fy;
      if not found or v_scan.payload is null then v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.'; end if;
    end if;
    if v_reason is null then
      v_p := v_scan.payload;
      v_num := coalesce(nullif(btrim(v_p->>'number'), ''), v_zid);
      begin v_date := (v_p->>'date')::date; exception when others then v_reason := 'Its date could not be read.'; end;
    end if;
    if v_reason is null then
      if lower(coalesce(v_p->>'status', '')) = 'void' then v_reason := 'Void in Zoho.';
      elsif jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then v_reason := v_p->'problems'->>0;
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif jsonb_typeof(v_p->'applied') <> 'array' or jsonb_array_length(v_p->'applied') = 0 then
        v_reason := 'An advance — not applied to any bill in Zoho; book it as an advance (Prepaid) by hand.';
      end if;
    end if;
    if v_reason is null and exists (select 1 from public.zoho_vendor_payment_links k where k.tenant_id = v_tenant and k.zoho_payment_id = v_zid) then
      v_already := v_already + 1;
      continue;
    end if;
    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    v_booked := 0; v_listed := 0; v_list_p := '[]'::jsonb; v_amt_p := 0;
    begin
      for v_a in select value from jsonb_array_elements(v_p->'applied') loop
        v_amt := (v_a->>'amount')::integer;
        /* This bill's Zoho payments in the scan (not void), oldest first: the TDS goes with the first. */
        select count(*), (array_agg(s.zoho_id order by s.doc_date, s.zoho_id))[1] into v_npays, v_first
          from public.zoho_fy_scan s cross join lateral jsonb_array_elements(case when jsonb_typeof(s.payload->'applied') = 'array' then s.payload->'applied' else '[]'::jsonb end) x(a)
         where s.tenant_id = v_tenant and s.kind = 'vendorpayments' and lower(coalesce(s.payload->>'status', '')) <> 'void'
           and x.a->>'billZohoId' = v_a->>'billZohoId';
        select * into v_bill from public.vendor_bills b where b.tenant_id = v_tenant and b.zoho_doc_id = 'bills:' || (v_a->>'billZohoId');
        if found then
          /* A COGS bill: paid in Reconcile on its bank debit (no "paid outside the bank" state for a COGS bill).
             Already paid in the app (reconciled) → nothing left to list. */
          if v_bill.status = 'paid' then continue; end if;
          v_list_p := v_list_p || jsonb_build_object('why', 'cogs', 'zoho_id', v_zid, 'number', v_num, 'date', v_date, 'bill', coalesce(v_bill.bill_no, v_bill.id),
            'bill_id', v_bill.id, 'amount', v_amt,
            'tds', case when v_first = v_zid then v_bill.zoho_tds_amount else 0 end,
            'tds_section', case when v_first = v_zid then v_bill.zoho_tds_section end);
          v_listed := v_listed + 1;
          continue;
        end if;
        select array_agg(e.id order by e.zoho_leg), coalesce(sum(e.amount), 0), coalesce(sum(e.tds_amount), 0),
               jsonb_object_agg(e.id, jsonb_build_object('paid', e.paid, 'paid_date', e.paid_date, 'payment_method', e.payment_method,
                                                         'bank_account_id', e.bank_account_id, 'reconciled_txn_id', e.reconciled_txn_id))
          into v_exp_ids, v_owed, v_tds, v_prev
          from public.expenses e where e.tenant_id = v_tenant and e.zoho_doc_id = 'bills:' || (v_a->>'billZohoId');
        if v_exp_ids is null then
          raise exception 'Bill % is not in the app yet — Import the bills first.', coalesce(nullif(v_a->>'billNumber', ''), v_a->>'billZohoId') using errcode = 'R2503';
        end if;
        if not exists (select 1 from public.expenses e where e.id = any (v_exp_ids) and not e.paid) then
          continue;   -- paid in the app already (Reconcile): nothing to book, nothing to list
        end if;
        if v_npays > 1 or v_amt + v_tds < v_owed then
          /* Paid in parts (or partly) in Zoho: never "paid" with one date — each part is paid in
             Reconcile on its own debit (R-1915 expense part payment, the TDS with the first part). */
          v_list_p := v_list_p || jsonb_build_object('why', 'parts', 'zoho_id', v_zid, 'number', v_num, 'date', v_date,
            'bill', coalesce(nullif(v_a->>'billNumber', ''), v_a->>'billZohoId'), 'bill_id', v_exp_ids[1], 'amount', v_amt,
            'tds', case when v_first = v_zid then v_tds else 0 end,
            'tds_section', case when v_first = v_zid and v_tds > 0 then (select e.tds_section from public.expenses e where e.id = v_exp_ids[1]) end);
          v_listed := v_listed + 1;
          continue;
        end if;
        if exists (select 1 from public.expenses e where e.id = any (v_exp_ids) and (e.paid or e.paid_amount > 0 or e.reconciled_txn_id is not null)) then
          raise exception 'Bill % is already paid in the app.', coalesce(nullif(v_a->>'billNumber', ''), v_a->>'billZohoId') using errcode = 'R2503';
        end if;
        if v_acct.id is null then
          if nullif(v_pick->>'account_id', '') is null or (v_pick->>'account_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            raise exception 'Choose the app account for Zoho''s "%" (paid from) — petty cash, card or bank.', coalesce(nullif(v_p->>'paidThrough', ''), 'no account') using errcode = 'R2503';
          end if;
          select * into v_acct from public.bank_accounts ba
           where ba.id = (v_pick->>'account_id')::uuid and ba.tenant_id = v_tenant and coalesce(ba.is_active, true) and ba.closed_on is null;
          if not found then
            raise exception 'The app account picked for Zoho''s "%" is not one of your open accounts — preview again.', coalesce(nullif(v_p->>'paidThrough', ''), 'no account') using errcode = 'R2503';
          end if;
        end if;
        insert into public.zoho_vendor_payment_links (tenant_id, batch_id, zoho_payment_id, zoho_bill_id, target_type, target_ids, amount, settled, prev)
        values (v_tenant, v_batch, v_zid, v_a->>'billZohoId', 'expense', v_exp_ids, v_amt, true, v_prev);
        perform public._r2502_mark_paid(v_exp_ids, v_date, v_acct);
        v_booked := v_booked + 1;
        v_amt_p := v_amt_p + v_amt;
      end loop;
    exception
      when others then
        v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', sqlerrm);
        continue;
    end;
    v_list := v_list || v_list_p;
    v_sum_amt := v_sum_amt + v_amt_p;
    if coalesce((v_p->>'unapplied')::integer, 0) > 0 then
      v_adv := v_adv || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'vendor', v_p->>'vendorName', 'amount', (v_p->>'unapplied')::integer);
    end if;
    if v_booked > 0 then v_n := v_n + 1; end if;
  end loop;

  update public.zoho_fy_import_batches
     set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
         amount_total = v_sum_amt, skipped = v_skipped
   where id = v_batch;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_vendor_payments.imported', 'zoho_fy_import_batch', v_batch::text,
          left(format('Imported %s FY %s Zoho vendor payments (₹%s); %s to pay in Reconcile; %s skipped', v_n, p_fy, v_sum_amt, jsonb_array_length(v_list), jsonb_array_length(v_skipped)), 120),
          jsonb_build_object('batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already, 'skipped', jsonb_array_length(v_skipped),
                             'amount', v_sum_amt, 'to_reconcile', v_list, 'advances', v_adv));
  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2502', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2502' then
    v_batch := null;
  end;

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already,
    'skipped', v_skipped, 'to_reconcile', v_list, 'advances', v_adv, 'amount', v_sum_amt);
end;
$function$;
comment on function public.import_zoho_fy_vendor_payments(text, jsonb, boolean) is
  'R-2502c: FY Zoho vendor payments. An expense bill paid by ONE covering payment is marked paid from the mapped app account (cash: petty-cash line; card / bank: banked by Reconcile). Bills paid in parts and COGS bills are listed (to_reconcile, with the bill''s Zoho TDS on its first payment) and paid in Reconcile on each debit. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_vendor_payments(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_vendor_payments(text, jsonb, boolean) to authenticated, service_role;

-- ── 5b. Import bills / expenses ─────────────────────────────────────────────────────────────
create or replace function public.import_zoho_fy_purchases(p_kind text, p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 — R-2502c: vendor GSTIN rule + change log, duplicate check, TDS spread, paid-from account, fingerprint */
  v_tenant   uuid := public.current_tenant_id();
  v_create   boolean;
  v_acct     public.bank_accounts;
  v_book     integer;
  v_dup      text;
  v_tx_all   integer;
  v_tds_leg  integer;
  v_tds_left integer;
  v_start    date;
  v_lock     date;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_zid      text;
  v_key      text;
  v_num      text;
  v_date     date;
  v_due      date;
  v_status   text;
  v_reason   text;
  v_vendor   public.vendors;
  v_gstin    text;
  v_valid_g  boolean;
  v_legs     jsonb;
  v_leg      jsonb;
  v_n_legs   integer;
  v_cogs     integer;
  v_cost     integer;
  v_rcm      boolean;
  v_tds      integer;
  v_tsec     text;
  v_taxable  integer;
  v_tax      integer;
  v_amount   integer;
  v_i        integer;
  v_ids      text[];
  v_hash     text;
  v_new_v    integer := 0;
  v_seen     text[] := array[]::text[];
  v_done     jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_n        integer := 0;
  v_sum_tx   bigint := 0;
  v_sum_tax  bigint := 0;
  v_sum_amt  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing purchases needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY purchases from Zoho. Ask one of them.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('bills', 'expenses') then
    raise exception 'Choose bills or expenses.' using errcode = '22023';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$' or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There is nothing to import. Read from Zoho again and preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many documents in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;

  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  /* One block: a dry run raises R2502 at the end, so the batch, every row, every vendor made and
     every trigger's work roll back — the preview ran the real thing. */
  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, p_kind, p_fy, auth.uid())
  returning id into v_batch;
  /* Only this import may write the Zoho id / batch on expenses and vendor_bills (tg_purchases_zoho_doc_guard). */
  perform set_config('app.zoho_purchase_import', 'on', true);

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_id', ''));
    v_key := p_kind || ':' || v_zid;
    v_reason := null;
    v_scan := null;
    v_num := v_zid;

    if v_zid = '' or v_zid = any (v_seen) then
      v_reason := 'Listed twice or with no Zoho id.';
    else
      v_seen := v_seen || v_zid;
      select * into v_scan from public.zoho_fy_scan s
       where s.tenant_id = v_tenant and s.kind = p_kind and s.zoho_id = v_zid and s.fy = p_fy;
      if not found or v_scan.payload is null then
        v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.';
      end if;
    end if;

    if v_reason is null then
      v_p      := v_scan.payload;
      v_num    := btrim(coalesce(v_p->>'number', ''));
      v_status := lower(coalesce(v_p->>'status', ''));
      v_rcm    := coalesce((v_p->>'rcm')::boolean, false);
      begin
        v_date := (v_p->>'date')::date;
        v_due  := nullif(v_p->>'dueDate', '')::date;
        v_tds  := coalesce((v_p->>'tdsAmount')::integer, 0);
      exception when others then
        v_reason := 'Its date or amounts could not be read — read it from Zoho again.';
      end;
      v_tsec := nullif(v_p->>'tdsSection', '');
    end if;

    if v_reason is null then
      if v_status = 'void' then v_reason := 'Void in Zoho — not a purchase, not in the P&L or ITC.';
      elsif v_status = 'draft' then v_reason := 'Draft in Zoho — never booked there.';
      elsif jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then
        v_reason := v_p->'problems'->>0;
      elsif char_length(v_num) > 60 then v_reason := 'The Zoho number is longer than 60 characters.';
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then
        v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then
        v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then
        v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then
        v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif v_tds < 0 or (v_tds > 0 and v_tsec is null) then
        v_reason := 'Its TDS has no section.';
      end if;
    end if;

    -- Already here (same Zoho id) → already (a rerun).
    if v_reason is null then
      if exists (select 1 from public.expenses e where e.tenant_id = v_tenant and e.zoho_doc_id = v_key)
         or exists (select 1 from public.vendor_bills b where b.tenant_id = v_tenant and b.zoho_doc_id = v_key) then
        v_already := v_already + 1;
        continue;
      end if;
    end if;

    -- Legs: one per category (the company's map; unmapped → "Unmapped — review"), first-seen order.
    if v_reason is null then
      select coalesce(jsonb_agg(jsonb_build_object(
               'category', g.category, 'taxable', g.taxable, 'gst', g.gst, 'cost_gst', g.cost_gst, 'rcm_tax', g.rcm_tax,
               'lines', g.lines) order by g.first_ord), '[]'::jsonb)
        into v_legs
        from (
          select c.category,
                 sum(coalesce((x.l->>'taxable')::integer, 0)) as taxable,
                 sum(case when not v_rcm and coalesce((x.l->>'itcEligible')::boolean, true) then coalesce((x.l->>'tax')::integer, 0) else 0 end) as gst,
                 sum(case when not v_rcm and not coalesce((x.l->>'itcEligible')::boolean, true) then coalesce((x.l->>'tax')::integer, 0) else 0 end) as cost_gst,
                 sum(case when v_rcm then coalesce((x.l->>'tax')::integer, 0) else 0 end) as rcm_tax,
                 min(x.ord) as first_ord,
                 jsonb_agg(x.l order by x.ord) as lines
            from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) with ordinality x(l, ord)
            left join public.zoho_account_category_map m
              on m.tenant_id = v_tenant and m.zoho_account_id = coalesce(x.l->>'accountId', '')
            /* R-2502c: a map row saved before the whitelist (any text) counts as unmapped. */
            cross join lateral (select coalesce(case when public._r2502_category_allowed(m.category) then m.category end, 'Unmapped — review') as category) c
           group by c.category
        ) g;
      v_n_legs := jsonb_array_length(v_legs);
      select count(*) filter (where (l->>'category') like 'COGS-%'), coalesce(sum((l->>'cost_gst')::integer), 0)
        into v_cogs, v_cost from jsonb_array_elements(v_legs) l;
      if v_n_legs = 0 then v_reason := 'It has no lines or account in Zoho.';
      elsif v_cogs > 0 and v_cogs < v_n_legs then v_reason := 'It has COGS and expense lines — add it by hand, or map its accounts to one kind.';
      elsif v_cogs > 0 and p_kind = 'expenses' then v_reason := 'A Zoho expense on a COGS account — add it as a COGS bill by hand.';
      elsif v_cogs > 0 and v_rcm then v_reason := 'A COGS bill under reverse charge — add it by hand.';
      elsif v_cogs > 0 and v_cost > 0 then v_reason := 'A COGS bill with ineligible ITC — add it by hand.';
      end if;
    end if;

    -- Vendor: the preview's pick (this company's), else Zoho contact id → GSTIN → the one vendor with
    -- that exact name whose GSTIN is empty or the same (R-2502c: never a vendor with another GSTIN),
    -- else made from Zoho — but only after the duplicate check below.
    if v_reason is null then
      v_vendor := null; v_create := false;
      v_gstin := upper(regexp_replace(coalesce(v_p->>'gstin', ''), '[\s.\-]+', '', 'g'));
      v_valid_g := v_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$';
      if nullif(v_pick->>'vendor_id', '') is not null then
        if (v_pick->>'vendor_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          v_reason := 'The vendor picked is not in your company — preview again.';
        else
          select * into v_vendor from public.vendors v where v.id = (v_pick->>'vendor_id')::uuid and v.tenant_id = v_tenant;
          if not found then v_reason := 'The vendor picked is not in your company — preview again.';
          elsif v_valid_g and coalesce(upper(regexp_replace(v_vendor.gstin, '[\s.\-]+', '', 'g')), '') not in ('', v_gstin) then
            v_reason := format('%s has GSTIN %s in the app, but Zoho''s bill says %s — preview again (a new vendor will be made).', v_vendor.name, v_vendor.gstin, v_gstin);
          end if;
        end if;
      else
        select * into v_vendor from public.vendors v
         where v.tenant_id = v_tenant and v.zoho_contact_id = nullif(v_p->>'vendorZohoId', '');
        if not found and v_valid_g then
          select * into v_vendor from public.vendors v
           where v.tenant_id = v_tenant and upper(regexp_replace(coalesce(v.gstin, ''), '[\s.\-]+', '', 'g')) = v_gstin
           order by v.created_at limit 1;
        end if;
        if v_vendor.id is null and (select count(*) from public.vendors v where v.tenant_id = v_tenant
                                      and lower(btrim(v.name)) = lower(btrim(coalesce(v_p->>'vendorName', '')))
                                      and (not v_valid_g or coalesce(upper(regexp_replace(v.gstin, '[\s.\-]+', '', 'g')), '') in ('', v_gstin))) = 1 then
          select * into v_vendor from public.vendors v
           where v.tenant_id = v_tenant and lower(btrim(v.name)) = lower(btrim(coalesce(v_p->>'vendorName', '')))
             and (not v_valid_g or coalesce(upper(regexp_replace(v.gstin, '[\s.\-]+', '', 'g')), '') in ('', v_gstin));
        end if;
        if v_vendor.id is null then
          if btrim(coalesce(v_p->>'vendorName', '')) = '' then v_reason := 'It has no vendor in Zoho.';
          else v_create := true;
          end if;
        end if;
      end if;
    end if;

    -- R-2502c: a Zoho expense is booked against the app account its paid-through account maps to.
    if v_reason is null and p_kind = 'expenses' then
      v_acct := null;
      if nullif(v_pick->>'account_id', '') is not null and (v_pick->>'account_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select * into v_acct from public.bank_accounts ba
         where ba.id = (v_pick->>'account_id')::uuid and ba.tenant_id = v_tenant and coalesce(ba.is_active, true) and ba.closed_on is null;
      end if;
      if v_acct.id is null then
        v_reason := format('Choose the app account for Zoho''s "%s" (paid from) — petty cash, card or bank.', coalesce(nullif(v_p->>'paidThrough', ''), '(no account in Zoho)'));
      end if;
    end if;

    -- R-2502c: already in the books without a Zoho id? Same vendor (or GSTIN) + date ±3 days + amount (±₹1).
    if v_reason is null then
      v_book := case when v_cogs > 0 then (v_p->>'taxable')::integer + (v_p->>'tax')::integer
                     else (select coalesce(sum((l->>'taxable')::integer + (l->>'gst')::integer + (l->>'cost_gst')::integer), 0) from jsonb_array_elements(v_legs) l) end;
      /* The same number of the same vendor first (the clearer reason). */
      if v_num <> '' and v_vendor.id is not null and (
           exists (select 1 from public.expenses e where e.tenant_id = v_tenant and e.zoho_doc_id is null and e.vendor_id = v_vendor.id and upper(btrim(e.bill_no)) = upper(v_num))
        or exists (select 1 from public.vendor_bills b where b.tenant_id = v_tenant and b.zoho_doc_id is null and b.vendor_id = v_vendor.id and upper(btrim(b.bill_no)) = upper(v_num))) then
        v_reason := format('Bill %s of %s is already in the books (entered by hand) — not imported twice.', v_num, v_vendor.name);
      end if;
    end if;
    if v_reason is null then
      select x.ref into v_dup from (
        select coalesce(e.bill_no, e.id) || ' (' || to_char(e.expense_date, 'DD Mon YYYY') || ', ₹' || e.amount || ')' as ref
          from public.expenses e left join public.vendors vv on vv.id = e.vendor_id
         where e.tenant_id = v_tenant and e.zoho_doc_id is null and e.category <> 'Salaries'
           and e.expense_date between v_date - 3 and v_date + 3 and abs(e.amount - v_book) <= 1
           and ((v_vendor.id is not null and e.vendor_id = v_vendor.id)
             or (v_valid_g and upper(regexp_replace(coalesce(vv.gstin, ''), '[\s.\-]+', '', 'g')) = v_gstin))
        union all
        select coalesce(b.bill_no, b.id) || ' (' || to_char(b.bill_date, 'DD Mon YYYY') || ', ₹' || b.total || ')'
          from public.vendor_bills b left join public.vendors vv on vv.id = b.vendor_id
         where b.tenant_id = v_tenant and b.zoho_doc_id is null
           and b.bill_date between v_date - 3 and v_date + 3 and abs(b.total - v_book) <= 1
           and ((v_vendor.id is not null and b.vendor_id = v_vendor.id)
             or (v_valid_g and upper(regexp_replace(coalesce(coalesce(vv.gstin, b.vendor_gstin), ''), '[\s.\-]+', '', 'g')) = v_gstin))
        limit 1) x;
      if v_dup is not null then
        v_reason := format('Looks already in the books (not from Zoho): %s — same vendor, ±3 days, same amount. Check it; delete one by hand if it is the same purchase.', v_dup);
      end if;
    end if;

    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    v_hash := upper(substr(md5(v_tenant::text || ':' || v_key), 1, 12));
    v_taxable := 0; v_tax := 0; v_amount := 0; v_ids := array[]::text[];
    begin
      /* The vendor is made / filled here, with the document: if the document is refused below, the
         vendor change rolls back with it (logged per batch — undo reverses it). */
        if v_create then
          insert into public.vendors (tenant_id, name, gstin, zoho_contact_id, notes)
          /* Vendor names are unique per company: a same-named supplier with another GSTIN gets its GSTIN in the name. */
          values (v_tenant,
                  case when exists (select 1 from public.vendors v where v.tenant_id = v_tenant and lower(btrim(v.name)) = lower(btrim(v_p->>'vendorName')))
                       then left(btrim(v_p->>'vendorName'), 170) || ' (' || case when v_valid_g then v_gstin else coalesce(nullif(v_p->>'vendorZohoId', ''), 'Zoho') end || ')'
                       else left(btrim(v_p->>'vendorName'), 200) end,
                  case when v_valid_g then v_gstin end,
                  case when nullif(v_p->>'vendorZohoId', '') is not null
                        and not exists (select 1 from public.vendors v where v.tenant_id = v_tenant and v.zoho_contact_id = v_p->>'vendorZohoId')
                       then v_p->>'vendorZohoId' end,
                  'Created from Zoho Books by the FY purchase import.')
          returning * into v_vendor;
          insert into public.zoho_purchase_vendor_changes (tenant_id, batch_id, vendor_id, created) values (v_tenant, v_batch, v_vendor.id, true);
        else
          /* Only FILL an empty Zoho contact id / GSTIN — never overwrite one. */
          if v_vendor.zoho_contact_id is null and nullif(v_p->>'vendorZohoId', '') is not null
             and not exists (select 1 from public.vendors v where v.tenant_id = v_tenant and v.zoho_contact_id = v_p->>'vendorZohoId') then
            update public.vendors set zoho_contact_id = v_p->>'vendorZohoId' where id = v_vendor.id returning * into v_vendor;
            insert into public.zoho_purchase_vendor_changes (tenant_id, batch_id, vendor_id, set_zoho_contact_id) values (v_tenant, v_batch, v_vendor.id, v_p->>'vendorZohoId');
          end if;
          /* The ITC rule reads the GSTIN from the vendor master (lib/gst/itc.ts): an empty one is filled. */
          if v_valid_g and coalesce(btrim(v_vendor.gstin), '') = ''
             and not exists (select 1 from public.vendors v where v.tenant_id = v_tenant and v.id <> v_vendor.id
                               and upper(regexp_replace(coalesce(v.gstin, ''), '[\s.\-]+', '', 'g')) = v_gstin) then
            update public.vendors set gstin = v_gstin where id = v_vendor.id returning * into v_vendor;
            insert into public.zoho_purchase_vendor_changes (tenant_id, batch_id, vendor_id, set_gstin) values (v_tenant, v_batch, v_vendor.id, v_gstin);
          end if;
        end if;
      if v_cogs > 0 then
        -- ONE COGS bill; its category = the largest leg's (one leg in practice).
        select l into v_leg from jsonb_array_elements(v_legs) l order by (l->>'taxable')::integer desc limit 1;
        v_taxable := (v_p->>'taxable')::integer;
        v_tax := (v_p->>'tax')::integer;
        v_amount := v_taxable + v_tax;
        insert into public.vendor_bills (
          id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category, line_items,
          subtotal, cgst, sgst, igst, total, status, paid_amount, currency, fx_rate, document_type, notes,
          zoho_doc_id, purchase_import_batch_id, zoho_tds_amount, zoho_tds_section)
        values (
          'BILL-Z-' || v_hash, v_tenant, v_vendor.id, v_vendor.name, case when v_valid_g then v_gstin else v_vendor.gstin end,
          nullif(v_num, ''), v_date, v_due, v_leg->>'category',
          (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'description', left(coalesce(nullif(btrim(l->>'description'), ''), l->>'accountName', 'Item'), 300),
             'hsn', nullif(left(btrim(coalesce(l->>'hsn', '')), 12), ''),
             'qty', coalesce((l->>'qty')::numeric, 1), 'amount', coalesce((l->>'taxable')::integer, 0)))), '[]'::jsonb)
             from jsonb_array_elements(v_p->'lines') l),
          v_taxable, (v_p->>'cgst')::integer, (v_p->>'sgst')::integer, (v_p->>'igst')::integer, v_amount, 'unpaid', 0, 'INR', 1,
          case when v_valid_g or coalesce(v_vendor.gstin, '') ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then 'tax_invoice' else 'other' end,
          left(format('Imported from Zoho Books (bill %s).', coalesce(nullif(v_num, ''), v_zid)), 500),
          v_key, v_batch, v_tds, case when v_tds > 0 then v_tsec end);
        update public.vendor_bills b set zoho_import_sig = public._r2502_bill_sig(b) where b.id = 'BILL-Z-' || v_hash;
        v_ids := array['BILL-Z-' || v_hash];
      else
        v_i := 0;
        select coalesce(sum((l->>'taxable')::integer), 0) into v_tx_all from jsonb_array_elements(v_legs) l;
        v_tds_left := v_tds;
        for v_leg in select l from jsonb_array_elements(v_legs) l loop
          v_i := v_i + 1;
          /* R-2502c: the TDS spread over the rows by taxable value (each row's 26Q base right); the last takes the rest. */
          v_tds_leg := case when v_i = v_n_legs or v_tx_all = 0 then v_tds_left
                            else least(v_tds_left, round(v_tds::numeric * (v_leg->>'taxable')::integer / v_tx_all)::integer) end;
          if v_tx_all = 0 and v_i > 1 then v_tds_leg := 0; end if;
          v_tds_left := v_tds_left - v_tds_leg;
          insert into public.expenses (
            id, tenant_id, category, vendor_name, vendor_id, expense_date, due_date, amount, gst_paid, igst, cgst, sgst,
            bill_type, bill_no, paid, paid_date, payment_method, description, notes, line_items,
            tds_section, tds_amount, rcm, rcm_tax, currency, fx_rate, zoho_doc_id, zoho_leg, purchase_import_batch_id)
          values (
            'EXP-Z-' || v_hash || '-' || v_i, v_tenant, v_leg->>'category', v_vendor.name, v_vendor.id, v_date,
            case when p_kind = 'bills' then coalesce(v_due, v_date) end,
            (v_leg->>'taxable')::integer + (v_leg->>'gst')::integer + (v_leg->>'cost_gst')::integer,
            (v_leg->>'gst')::integer,
            public._r2502_leg_head('igst', v_n_legs, v_rcm, v_leg, v_p),
            public._r2502_leg_head('cgst', v_n_legs, v_rcm, v_leg, v_p),
            public._r2502_leg_head('sgst', v_n_legs, v_rcm, v_leg, v_p),
            case when v_valid_g or coalesce(v_vendor.gstin, '') ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then 'gst' else 'none' end,
            nullif(v_num, ''),
            false, null, null,
            left(nullif(btrim(coalesce((select string_agg(nullif(btrim(coalesce(l->>'description', '')), ''), ', ') from jsonb_array_elements(v_leg->'lines') l), '')), ''), 500),
            left(format('Imported from Zoho Books (%s %s).%s%s', case when p_kind = 'bills' then 'bill' else 'expense' end, coalesce(nullif(v_num, ''), v_zid),
              case when (v_leg->>'cost_gst')::integer > 0 then format(' GST ₹%s not claimable in Zoho (ineligible ITC) — kept in the cost.', v_leg->>'cost_gst') else '' end,
              case when p_kind = 'expenses' and coalesce(v_p->>'paidThrough', '') <> '' then format(' Paid from %s in Zoho.', v_p->>'paidThrough') else '' end), 500),
            (select coalesce(jsonb_agg(jsonb_build_object(
               'name', left(coalesce(nullif(btrim(l->>'description'), ''), l->>'accountName', 'Item'), 300),
               'qty', coalesce((l->>'qty')::numeric, 1), 'amount', coalesce((l->>'taxable')::integer, 0))), '[]'::jsonb)
               from jsonb_array_elements(v_leg->'lines') l),
            case when v_tds_leg > 0 then v_tsec end, v_tds_leg,
            v_rcm, case when v_rcm then (v_leg->>'rcm_tax')::integer else 0 end,
            'INR', 1, v_key, v_i, v_batch);
          update public.expenses e set zoho_import_sig = public._r2502_expense_sig(e) where e.id = 'EXP-Z-' || v_hash || '-' || v_i;
          v_ids := v_ids || ('EXP-Z-' || v_hash || '-' || v_i);
          v_taxable := v_taxable + (v_leg->>'taxable')::integer;
          v_tax := v_tax + (v_leg->>'gst')::integer;
          v_amount := v_amount + (v_leg->>'taxable')::integer + (v_leg->>'gst')::integer + (v_leg->>'cost_gst')::integer;
        end loop;
        /* A Zoho expense was paid when it was made: paid from the mapped account (cash → its petty-cash line). */
        if p_kind = 'expenses' then
          perform public._r2502_mark_paid(v_ids, v_date, v_acct);
        end if;
      end if;
    exception
      when others then
        v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', sqlerrm);
        continue;
    end;

    v_n := v_n + 1;
    if v_create then v_new_v := v_new_v + 1; end if;
    v_sum_tx := v_sum_tx + v_taxable;
    v_sum_tax := v_sum_tax + v_tax;
    v_sum_amt := v_sum_amt + v_amount;
    v_done := v_done || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'ids', to_jsonb(v_ids),
      'target', case when v_cogs > 0 then 'vendor_bill' else 'expense' end, 'date', v_date, 'taxable', v_taxable, 'itc', v_tax, 'tds', v_tds);
  end loop;

  update public.zoho_fy_import_batches
     set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
         taxable_total = v_sum_tx, tax_total = v_sum_tax, amount_total = v_sum_amt, skipped = v_skipped
   where id = v_batch;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_purchases.imported', 'zoho_fy_import_batch', v_batch::text,
          left(format('Imported %s FY %s Zoho %s (taxable ₹%s, ITC ₹%s); %s skipped', v_n, p_fy, p_kind, v_sum_tx, v_sum_tax, jsonb_array_length(v_skipped)), 120),
          jsonb_build_object('batch_id', v_batch, 'kind', p_kind, 'fy', p_fy, 'imported', v_n, 'already', v_already,
                             'skipped', jsonb_array_length(v_skipped), 'taxable', v_sum_tx, 'itc', v_sum_tax, 'amount', v_sum_amt, 'new_vendors', v_new_v));

  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2502', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2502' then
    v_batch := null;
  end;
  perform set_config('app.zoho_purchase_import', '', true);

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'kind', p_kind, 'fy', p_fy,
    'imported', v_n, 'already', v_already, 'skipped', v_skipped, 'done', v_done, 'new_vendors', v_new_v,
    'taxable', v_sum_tx, 'itc', v_sum_tax, 'amount', v_sum_amt);
end;
$function$;
comment on function public.import_zoho_fy_purchases(text, text, jsonb, boolean) is 'R-2502c: FY bills / expenses from Zoho into vendor_bills (all-COGS, Zoho TDS in zoho_tds_*) or expenses (one row per category, TDS spread by taxable; a Zoho expense paid from the mapped app account). Money from zoho_fy_scan; picks = Zoho id + matched vendor (+ account). Duplicate check (vendor/GSTIN ±3 days amount). dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_purchases(text, text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_purchases(text, text, jsonb, boolean) to authenticated, service_role;

-- ── 7. Undo (R-2502c) ────────────────────────────────────────────────────────────────────────
create or replace function public.remove_zoho_fy_purchase_import(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 — R-2502c: refuses rows edited since the import; deletes the import's own petty-cash
     lines; reverses the vendor fields the import set. */
  v_tenant uuid := public.current_tenant_id();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_batch  public.zoho_fy_import_batches;
  v_bad    text;
  v_k      public.zoho_vendor_payment_links;
  v_c      public.zoho_purchase_vendor_changes;
  v_n      integer := 0;
  v_m      integer;
begin
  if v_tenant is null then
    raise exception 'Removing an import needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can remove an import.' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'Write why you are removing this import (at least 3 characters) — it goes in the activity log.' using errcode = '22023';
  end if;
  select * into v_batch from public.zoho_fy_import_batches where id = p_batch_id and tenant_id = v_tenant for update;
  if not found or v_batch.kind not in ('bills', 'expenses', 'vendorpayments') then
    raise exception 'That import was not found. Refresh and look at the imports list again.' using errcode = 'P0002';
  end if;
  if v_batch.removed_at is not null then
    raise exception 'This import was already removed on %.', to_char(v_batch.removed_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
  end if;

  if v_batch.kind in ('bills', 'expenses') then
    /* Edited after the import → the person's work; never deleted by an undo. */
    select string_agg(x.ref, ', ') into v_bad from (
      select coalesce(e.bill_no, e.id) as ref from public.expenses e
       where e.purchase_import_batch_id = p_batch_id and e.tenant_id = v_tenant
         and e.zoho_import_sig is distinct from public._r2502_expense_sig(e)
      union all
      select coalesce(b.bill_no, b.id) from public.vendor_bills b
       where b.purchase_import_batch_id = p_batch_id and b.tenant_id = v_tenant
         and b.zoho_import_sig is distinct from public._r2502_bill_sig(b)
      limit 20) x;
    if v_bad is not null then
      raise exception 'This import cannot be removed: % was edited after the import. Undo that edit, or delete those rows by hand.', v_bad using errcode = 'P0001';
    end if;
    select string_agg(x.ref, ', ') into v_bad from (
      select coalesce(e.bill_no, e.id) as ref from public.expenses e
       where e.purchase_import_batch_id = p_batch_id and e.tenant_id = v_tenant
         and ((e.reconciled_txn_id is not null and not exists (select 1 from public.bank_transactions t where t.id = e.reconciled_txn_id
                 and t.source = 'manual' and t.matched_to_type = 'expense' and t.matched_to_id = e.id and t.description like 'Zoho FY import · %'))
           or e.advance_applied > 0 or e.paid_amount > 0
           or (e.paid and v_batch.kind = 'bills')
           or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id)
           or exists (select 1 from public.zoho_vendor_payment_links k where k.tenant_id = v_tenant and e.id = any (k.target_ids)))
      union all
      select coalesce(b.bill_no, b.id) from public.vendor_bills b
       where b.purchase_import_batch_id = p_batch_id and b.tenant_id = v_tenant
         and (b.paid_amount <> 0 or b.advance_applied > 0
           or exists (select 1 from public.bank_vendor_payment_lines l where l.vendor_bill_id = b.id)
           or exists (select 1 from public.bank_transactions t where t.matched_to_type = 'vendor_bill' and t.matched_to_id = b.id))
      limit 20) x;
    if v_bad is not null then
      raise exception 'This import cannot be removed: % already has a payment or bank match. Take that off first (or remove the payments import), then remove this one.', v_bad using errcode = 'P0001';
    end if;
    -- The import's own petty-cash lines go first (they point at the expenses).
    delete from public.bank_transactions t
     using public.expenses e
     where e.purchase_import_batch_id = p_batch_id and e.tenant_id = v_tenant
       and t.id = e.reconciled_txn_id and t.source = 'manual' and t.matched_to_type = 'expense' and t.matched_to_id = e.id
       and t.description like 'Zoho FY import · %';
    delete from public.expenses where purchase_import_batch_id = p_batch_id and tenant_id = v_tenant;
    get diagnostics v_m = row_count; v_n := v_m;
    delete from public.vendor_bills where purchase_import_batch_id = p_batch_id and tenant_id = v_tenant;
    get diagnostics v_m = row_count; v_n := v_n + v_m;
    -- Vendor fields this import set: put back (only while still what it set); vendors it made: removed when nothing uses them.
    for v_c in select * from public.zoho_purchase_vendor_changes where batch_id = p_batch_id and tenant_id = v_tenant order by created_at desc loop
      if v_c.set_zoho_contact_id is not null then
        update public.vendors set zoho_contact_id = null where id = v_c.vendor_id and tenant_id = v_tenant and zoho_contact_id = v_c.set_zoho_contact_id;
      end if;
      if v_c.set_gstin is not null then
        update public.vendors set gstin = null where id = v_c.vendor_id and tenant_id = v_tenant and gstin = v_c.set_gstin;
      end if;
      if v_c.created then
        begin
          delete from public.vendors v where v.id = v_c.vendor_id and v.tenant_id = v_tenant
             and not exists (select 1 from public.expenses e where e.vendor_id = v.id)
             and not exists (select 1 from public.vendor_bills b where b.vendor_id = v.id);
        exception when others then null;   -- still used elsewhere (FK): it stays
        end;
      end if;
    end loop;
    delete from public.zoho_purchase_vendor_changes where batch_id = p_batch_id and tenant_id = v_tenant;
  else
    /* A later payments import on the same bill builds on this one — take that back first. */
    select string_agg(distinct k2.zoho_bill_id, ', ') into v_bad
      from public.zoho_vendor_payment_links k
      join public.zoho_vendor_payment_links k2
        on k2.tenant_id = k.tenant_id and k2.zoho_bill_id = k.zoho_bill_id and k2.batch_id <> k.batch_id and k2.created_at > k.created_at
     where k.batch_id = p_batch_id and k.tenant_id = v_tenant;
    if v_bad is not null then
      raise exception 'A later payments import also paid the same bills (Zoho bill %) — remove that import first.', v_bad using errcode = 'P0001';
    end if;
    for v_k in select * from public.zoho_vendor_payment_links where batch_id = p_batch_id and tenant_id = v_tenant order by created_at desc, id loop
      if v_k.target_type = 'vendor_bill' then
        -- (made only before R-2502b) the manual line of pay_vendor_bill, while still unmatched
        if v_k.bank_txn_id is null or not exists (select 1 from public.bank_transactions t where t.id = v_k.bank_txn_id and t.source = 'manual'
                                                    and t.matched_to_type = 'vendor_bill' and t.matched_to_id = v_k.target_ids[1]) then
          raise exception 'The payment on COGS bill % was matched to a bank line already — un-reconcile it in Banking first.', v_k.target_ids[1] using errcode = 'P0001';
        end if;
        delete from public.bank_vendor_payment_lines where bank_txn_id = v_k.bank_txn_id;
        delete from public.bank_transactions where id = v_k.bank_txn_id;
        update public.vendor_bills
           set paid_amount = greatest(0, paid_amount - v_k.amount - v_k.tds_amount),
               status = case when paid_amount - v_k.amount - v_k.tds_amount <= 0 then 'unpaid'
                             when paid_amount - v_k.amount - v_k.tds_amount >= total then 'paid' else 'partial' end,
               updated_at = now()
         where id = v_k.target_ids[1] and tenant_id = v_tenant;
      else
        if exists (select 1 from public.expenses e where e.id = any (v_k.target_ids)
                     and ((e.reconciled_txn_id is not null and not exists (select 1 from public.bank_transactions t where t.id = e.reconciled_txn_id
                            and t.source = 'manual' and t.matched_to_type = 'expense' and t.matched_to_id = e.id and t.description like 'Zoho FY import · %'))
                          or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id))) then
          raise exception 'Expense bill % was matched to a bank line already — un-reconcile it in Banking first.', v_k.target_ids[1] using errcode = 'P0001';
        end if;
        if v_k.settled then
          delete from public.bank_transactions t
           using public.expenses e
           where e.id = any (v_k.target_ids) and t.id = e.reconciled_txn_id and t.source = 'manual'
             and t.matched_to_type = 'expense' and t.matched_to_id = e.id and t.description like 'Zoho FY import · %';
          update public.expenses e
             set paid = coalesce((v_k.prev->e.id->>'paid')::boolean, false),
                 paid_date = nullif(v_k.prev->e.id->>'paid_date', '')::date,
                 payment_method = nullif(v_k.prev->e.id->>'payment_method', ''),
                 bank_account_id = nullif(v_k.prev->e.id->>'bank_account_id', '')::uuid,
                 reconciled_txn_id = nullif(v_k.prev->e.id->>'reconciled_txn_id', '')::uuid
           where e.id = any (v_k.target_ids) and e.tenant_id = v_tenant;
        end if;
      end if;
      delete from public.zoho_vendor_payment_links where id = v_k.id;
      v_n := v_n + 1;
    end loop;
  end if;

  update public.zoho_fy_import_batches
     set removed_at = now(), removed_by = auth.uid(), remove_reason = left(v_reason, 500), removed_rows = v_n
   where id = p_batch_id;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_purchases.import_removed', 'zoho_fy_import_batch', p_batch_id::text,
          left(format('Removed FY %s Zoho %s import: %s rows — %s', v_batch.fy, v_batch.kind, v_n, v_reason), 120),
          jsonb_build_object('batch_id', p_batch_id, 'kind', v_batch.kind, 'removed', v_n, 'reason', v_reason, 'fy', v_batch.fy));
  return jsonb_build_object('removed', v_n, 'batch_id', p_batch_id, 'kind', v_batch.kind);
end;
$function$;
comment on function public.remove_zoho_fy_purchase_import(uuid, text) is
  'R-2502c: takes one FY purchase / vendor-payment import batch back while untouched (no edit since the import, no payment or bank match). Deletes its own petty-cash lines; reverses vendor fields it set. Owner / accountant; activity_log; the batch row stays, marked removed.';
revoke all on function public.remove_zoho_fy_purchase_import(uuid, text) from public, anon;
grant execute on function public.remove_zoho_fy_purchase_import(uuid, text) to authenticated, service_role;

commit;
