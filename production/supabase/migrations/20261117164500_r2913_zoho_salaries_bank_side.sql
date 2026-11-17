-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_debit_vendor_open_items(uuid)') and prosrc like '%R-2913%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_debit_to_vendor(uuid,uuid,jsonb,jsonb,jsonb,integer,text,integer,text)') and prosrc like '%R-2913%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.zoho_expense_bank_matches(uuid)') and prosrc like '%R-2913%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_expense(uuid,text,text,integer,text)') and prosrc like '%R-2913%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.suggest_bank_transaction_matches(uuid)') and prosrc like '%R-2913%')
-- deploy-key: r2913zohosalariesbankside
--
-- R-2913 (17 Nov 2026, p0 paisa, G-FY2526 — found by R-2911's code review; ships with R-2911).
-- R-2911 imports a FY 2025-26 Zoho salary as a PAID expense of category Salaries (paid from its mapped
-- account, no bank line) when Payroll has no payslip for that employee + month. But the bank side still
-- read "Salaries" as "Payroll's row" and skipped it everywhere:
--   · bank_debit_vendor_open_items (R-1911's recorded-payment list, read by bank_debit_vendor_auto_match,
--     R-1917's guard and R-2677) never listed it, and reconcile_bank_debit_to_vendor
--     {source: recorded_payment} refused it;
--   · zoho_expense_bank_matches (R-2655 "Match Zoho expenses") never listed it;
--   · suggest_bank_transaction_matches never offered it on its bank line (the only match door of a
--     salary with no vendor);
--   · book_bank_txn_as_expense's "R-2680 zoho-covered guard" did not see it — so the salary's real debit
--     was never offered for matching and "Book as expense" on it wrote the salary a SECOND time.
--
-- THE FIX — one rule in all five, nothing else changed (each function from its NEWEST body; checked on
-- every anutech/* branch and against the local DB's pg_proc):
--     e.category <> 'Salaries'   →   (e.category <> 'Salaries' or e.zoho_doc_id is not null)
-- A Salaries row WITH a zoho_doc_id is an imported expense (only the import may write zoho_doc_id —
-- tg_purchases_zoho_doc_guard); a Salaries row WITHOUT one is Payroll's (pay_salary) and keeps today's
-- behaviour everywhere: paid through salary_payments ('salary' suggestions, the salary sheet).
--   1. bank_debit_vendor_open_items ← 20261106021100_r2502c: the R-1911 (b) "marked paid, no bank line"
--      list only. The UNPAID expense-bill list is unchanged (R-2911 never imports an unpaid Salaries row).
--   2. reconcile_bank_debit_to_vendor (9 arguments) ← 20261101071500_r2335: the recorded-payment
--      (Mark paid) branch accepts a Zoho-imported Salaries row. The unpaid-bill / new-bill / advance
--      refusals of Salaries are unchanged. The 12-argument form (R-1916) calls this one — not redefined.
--   3. zoho_expense_bank_matches ← 20261111161638_r2655: open_rows (documents and rivals).
--   4. book_bank_txn_as_expense ← 20261111222942_r2680: open_paid of the zoho-covered guard.
--   5. suggest_bank_transaction_matches ← 20261107205640_r2192: the 'expense' suggestions.
-- The three lists (1, 3, 4) stay part-for-part equal (R-2655's comment). Signatures, return columns and
-- grants are unchanged — R-2677 (Match all exact) calls 1, 2 and 5 and keeps its own Salaries filter, so a
-- Zoho salary's line goes to the drawer there, never into a bulk run.
-- Money rules: S7 / S9 (one imported document covers one debit; the server refuses a second booking),
-- G19 / G20 (what the import brings in). Stored data is not changed.
-- Test: supabase/tests/r2913_zoho_salaries_bank_side.test.sql (red without this file);
--       r2680 test C and r2655's note updated (a Zoho Salaries row is now covered).
-- Rollback: re-run each function from the migration named above.

begin;

-- ── 1. Recorded payments (R-1911 list) ← 20261106021100_r2502c ────────────────────────────────
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
  /* R-1866 / §17c: fail closed for a login with no company. R-1911: recorded payments added. R-1913: less the advance applied. R-1915: expense bills part-paid. — R-2502c: COGS bill pre-fills its Zoho TDS. — R-2913: a Zoho-imported Salaries row is a recorded payment too (Payroll's rows stay out). */
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
       /* R-2913: only PAYROLL's Salaries rows stay out — a salary imported from Zoho (zoho_doc_id) is a
          recorded payment like any other imported expense. */
       and (e.category <> 'Salaries' or e.zoho_doc_id is not null)
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

-- ── 2. Matching a recorded payment ← 20261101071500_r2335 (9 arguments; the 12-argument R-1916 form calls it) ──
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
  v_ovr       text;     -- R-2320: the owner's reason for TDS below the threshold (null = none)
  v_ovr_log   jsonb := '[]'::jsonb;   -- R-2320: overrides to write to the activity log
  v_paid_tds  integer;  -- R-2320: TDS already on a COGS bill
  v_remember  boolean := false;  -- R-2338: the owner ticked "Remember for this vendor"
begin
  /* §17c fail-closed + R-718 money roles. R-1915: an expense bill can be paid in parts.
     R-1914: an advance may carry a COGS head (the vendor's own by default).
     R-2321: a NEW expense bill typed here can be part-paid too ("Paying now").
     R-2335: a Bills-page payment that withheld TDS can be matched here; its TDS row moves along.
     R-2320: a COGS bill (open or new) takes services TDS (194C / 194J …) like an expense bill;
     the owner may override the app's "below threshold" with a reason (logged).
     R-2338: the vendor's TDS section is saved only on the owner's "Remember for this vendor". */
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
    v_ovr := case when v_tds > 0 then public.vendor_tds_override_reason(it->>'tds_override_reason', v_trusted) end;

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
        /* R-2335: TDS withheld on the Bills page (pay_vendor_bill) sits on that manual line — it
           moves to this bank line, marked, so un-reconciling puts it back on the manual line. */
        update public.bank_vendor_payment_lines
           set bank_txn_id = p_txn_id, prev = jsonb_build_object('tds_from_txn', v_syn.id)
         where bank_txn_id = v_syn.id;
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
        /* R-2913: a Salaries row imported from Zoho (zoho_doc_id) is matched like any imported expense —
           only Payroll's own Salaries rows are refused here (the open-items list, part for part). */
        if upper(coalesce(v_exp.currency, 'INR')) <> 'INR' or v_exp.prepaid_advance_id is not null
           or (v_exp.category = 'Salaries' and v_exp.zoho_doc_id is null)
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
      select coalesce(sum(l.tds_amount), 0) into v_paid_tds
        from public.bank_vendor_payment_lines l where l.vendor_bill_id = v_doc and l.tds_amount > 0;
      if v_tds > 0 and coalesce(v_sec, '194Q') <> '194Q' then
        /* R-2320: services TDS (194C / 194J …) on a COGS bill — the expense-bill rules (R-1915):
           the bill's whole TDS goes with its FIRST payment, less than the amount settled, not
           more than the value before GST. */
        if v_paid_tds > 0 or coalesce(v_bill.paid_amount, 0) > 0 then
          raise exception 'TDS on bill % goes with its first payment (₹% TDS already, ₹% paid) — pay this part without TDS.',
            coalesce(v_bill.bill_no, v_doc), v_paid_tds, coalesce(v_bill.paid_amount, 0) using errcode = '22023';
        end if;
        if v_tds > coalesce(v_bill.subtotal, 0) then
          raise exception 'TDS ₹% cannot be more than the value before GST (₹%) of bill %.', v_tds, coalesce(v_bill.subtotal, 0), coalesce(v_bill.bill_no, v_doc)
            using errcode = '22023';
        end if;
        if v_tds >= v_amt then
          raise exception 'Bill %: the TDS ₹% must be less than the amount settled ₹%.', coalesce(v_bill.bill_no, v_doc), v_tds, v_amt using errcode = '22023';
        end if;
        v_qbase := coalesce(v_bill.subtotal, 0);
      elsif v_tds > 0 then
        if exists (select 1 from public.bank_vendor_payment_lines l
                    where l.vendor_bill_id = v_doc and l.tds_amount > 0 and coalesce(l.tds_section, '194Q') <> '194Q') then
          raise exception 'Bill % already had % TDS deducted — 194Q does not apply on top of it.', coalesce(v_bill.bill_no, v_doc),
            (select l.tds_section from public.bank_vendor_payment_lines l where l.vendor_bill_id = v_doc and l.tds_amount > 0 limit 1)
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
                                                    tds_amount, tds_section, tds_base, tds_on, tds_override_reason, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'bill', v_doc, v_amt - v_tds,
              v_tds, case when v_tds > 0 then v_sec end, v_qbase,
              case when v_tds > 0 then v_txn.txn_date end, v_ovr, v_uid);
      v_cash := v_cash + (v_amt - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      if v_tds > 0 and coalesce((it->>'remember_tds_section')::boolean, false) then v_remember := true; end if;  -- R-2338
      if v_ovr is not null then
        v_ovr_log := v_ovr_log || jsonb_build_object('source', 'vendor_bill', 'doc_id', v_doc, 'bill_no', v_bill.bill_no,
                       'tds_amount', v_tds, 'tds_section', v_sec, 'reason', v_ovr);
      end if;
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

      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, tds_amount, tds_section, prev, tds_override_reason, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'expense', v_doc, v_amt - v_tds, v_tds, v_sec,
              jsonb_build_object('tds_amount', v_exp.tds_amount, 'tds_section', v_exp.tds_section, 'paid_date', v_exp.paid_date,
                                 'payment_method', v_exp.payment_method, 'bank_account_id', v_exp.bank_account_id, 'vendor_id', v_exp.vendor_id,
                                 'paid_amount', coalesce(v_exp.paid_amount, 0)),
              v_ovr, v_uid);
      if v_ovr is not null then
        v_ovr_log := v_ovr_log || jsonb_build_object('source', 'expense', 'doc_id', v_doc, 'bill_no', v_exp.bill_no,
                       'tds_amount', v_tds, 'tds_section', v_sec, 'reason', v_ovr);
      end if;
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
      if v_tds > 0 and coalesce((it->>'remember_tds_section')::boolean, false) then v_remember := true; end if;  -- R-2338
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
    v_ovr := case when v_tds > 0 then public.vendor_tds_override_reason(p_new_bill->>'tds_override_reason', v_trusted) end;
    if v_own_state is not null and v_v_state is not null and v_own_state <> v_v_state then
      v_igst := v_gst; v_cgst := 0; v_sgst := 0;
    else
      v_igst := 0; v_cgst := v_gst / 2; v_sgst := v_gst - v_gst / 2;
    end if;

    if v_kind = 'cogs' then
      if v_cat is null or v_cat not like 'COGS-%' then raise exception 'New COGS bill: pick a COGS category.' using errcode = '22023'; end if;
      if v_tds > 0 and v_sec = '194Q' then
        -- R-1891: 194Q is worked out on a saved bill (its place in the year's purchases).
        raise exception 'TDS on a COGS bill typed here cannot be taken — record the bill first (Bills → Record a bill), then pay it here: the 194Q TDS is worked out on the saved bill.' using errcode = '22023';
      end if;
      -- R-2320: services TDS (194C / 194J …) on a new COGS bill — its whole TDS goes with this payment.
      if v_tds > 0 and v_pay <= v_tds then
        raise exception 'New bill: paying now ₹% must be more than the TDS ₹% on it.', v_pay, v_tds using errcode = '22023';
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
      -- R-2320: the bill's paid_amount is cash + TDS (as R-1891); the leg carries the cash.
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash,
                                                    tds_amount, tds_section, tds_base, tds_on, tds_override_reason, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'new_bill', v_id, v_pay - v_tds,
              v_tds, case when v_tds > 0 then v_sec end, case when v_tds > 0 then v_taxable else 0 end,
              case when v_tds > 0 then v_txn.txn_date end, v_ovr, v_uid);
      v_cash := v_cash + (v_pay - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      if v_tds > 0 and coalesce((p_new_bill->>'remember_tds_section')::boolean, false) then v_remember := true; end if;  -- R-2338
      v_new := jsonb_build_object('source', 'vendor_bill', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no', 'total', v_total,
                 'settled', v_pay, 'cash', v_pay - v_tds, 'tds', v_tds, 'tds_section', case when v_tds > 0 then v_sec end,
                 'status', case when v_pay >= v_total then 'paid' else 'partial' end,
                 'still_due', v_total - v_pay);
    else
      if v_cat is null or v_cat like 'COGS-%' or v_cat = 'Salaries' then
        raise exception 'New expense bill: pick an expense category (Salaries go through Payroll).' using errcode = '22023';
      end if;
      /* R-2321: "Paying now" may be less than the bill. The bill is saved with its full total and
         only this part (cash + TDS) is settled by the line — the rest stays due, exactly like an
         R-1915 part-paid bill (paid = false, paid_amount = the cash). Its whole TDS goes with this
         first part (R-1915 rule). Paid in full: as before (paid, linked to this line). */
      if v_pay <= v_tds then
        raise exception 'New bill: paying now ₹% must be more than the TDS ₹% on it.', v_pay, v_tds using errcode = '22023';
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
         nullif(trim(coalesce(p_new_bill->>'bill_no', '')), ''), case when v_pay >= v_total then 'bank' end,
         coalesce(nullif(trim(coalesce(p_note, '')), ''), v_txn.description),
         v_pay >= v_total, case when v_pay >= v_total then v_txn.txn_date end,
         case when v_pay >= v_total then v_txn.bank_account_id end, case when v_pay >= v_total then p_txn_id end,
         case when v_tds > 0 then v_sec end, v_tds);
      if v_pay < v_total then
        -- R-2321: a part — the cash is on the bill like an R-1915 bank part (open items, payables).
        update public.expenses set paid_amount = v_pay - v_tds where id = v_id;
      end if;
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, tds_amount, tds_section, tds_override_reason, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'new_expense', v_id, v_pay - v_tds, v_tds, case when v_tds > 0 then v_sec end, v_ovr, v_uid);
      v_cash := v_cash + (v_pay - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      if v_tds > 0 and coalesce((p_new_bill->>'remember_tds_section')::boolean, false) then v_remember := true; end if;  -- R-2338
      v_new := jsonb_build_object('source', 'expense', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no', 'total', v_total,
                 'settled', v_pay, 'cash', v_pay - v_tds, 'tds', v_tds, 'tds_section', case when v_tds > 0 then v_sec end,
                 'status', case when v_pay >= v_total then 'paid' else 'partial' end, 'still_due', v_total - v_pay);
    end if;
    if v_ovr is not null then
      v_ovr_log := v_ovr_log || jsonb_build_object('source', v_new->>'source', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no',
                     'tds_amount', v_tds, 'tds_section', v_sec, 'reason', v_ovr);
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

  /* R-2338: the vendor's TDS section is saved ONLY when the owner ticked "Remember for this
     vendor" (it was taught by itself on the first TDS payment before — never auto-set now). */
  if v_remember and v_tds_sec is not null then
    update public.vendors set default_tds_section = v_tds_sec, updated_at = now() where id = v_vendor.id;
  end if;

  update public.bank_transactions
     set matched_to_type = 'vendor_payment', matched_to_id = v_vendor.id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = v_uid, updated_at = now()
   where id = p_txn_id;

  /* R-2320: every owner override of the TDS threshold, in the activity log (who, what, why). */
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  select v_txn.tenant_id, v_uid, 'tds_override', case when o->>'source' = 'expense' then 'expense' else 'vendor_bill' end, o->>'doc_id',
         'TDS ₹' || (o->>'tds_amount') || ' (' || coalesce(o->>'tds_section', '—') || ') taken below the threshold on '
           || coalesce('bill ' || nullif(o->>'bill_no', ''), o->>'doc_id') || ' of ' || v_vendor.name || ' — ' || (o->>'reason'),
         o || jsonb_build_object('bank_txn_id', p_txn_id, 'vendor_id', v_vendor.id, 'tds_amount', (o->>'tds_amount')::int)
    from jsonb_array_elements(v_ovr_log) o;

  return jsonb_build_object(
    'vendor_id', v_vendor.id, 'vendor_name', v_vendor.name, 'vendor_created', p_vendor_id is null,
    'bank_amount', v_txn.debit, 'paid', v_paid, 'new_bill', v_new, 'advance', v_adv, 'bank_charge', v_charge,
    'tds_total', v_tds_total, 'tds_section', v_tds_sec);
end;
$$;

revoke all on function public.reconcile_bank_debit_to_vendor(uuid, uuid, jsonb, jsonb, jsonb, integer, text, integer, text) from public, anon;
grant execute on function public.reconcile_bank_debit_to_vendor(uuid, uuid, jsonb, jsonb, jsonb, integer, text, integer, text) to authenticated, service_role;

-- ── 3. Match Zoho expenses (preview) ← 20261111161638_r2655 ──────────────────────────────────
create or replace function public.zoho_expense_bank_matches(p_account_id uuid default null)
returns table(
  status text, reason text,
  zoho_doc_id text, vendor_id uuid, vendor_name text, bill_no text, categories text,
  doc_date date, paid_on date, cash integer, parts integer, expense_ids text[], reference text,
  account_id uuid, account text,
  txn_id uuid, txn_date date, txn_description text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid := public._r2655_match_gate(); v_lock date;
begin
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;
  return query
  with open_rows as (
    /* Every open "recorded payment" expense row of the company — the R-1911 (b) list, part for part,
       written ONCE here (the documents and their rivals both read it). R-2913: a Salaries row
       imported from Zoho is in; Payroll's own Salaries rows (no zoho_doc_id) stay out. */
    select e.id, e.zoho_doc_id as zdoc, e.bank_account_id, coalesce(e.paid_date, e.expense_date) as paid_on,
           e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) as cash
      from public.expenses e
     where e.tenant_id = v_tenant
       and e.paid = true and e.reconciled_txn_id is null
       and upper(coalesce(e.currency, 'INR')) = 'INR'
       and (e.category <> 'Salaries' or e.zoho_doc_id is not null)   -- R-2913: Payroll's Salaries rows only
       and lower(coalesce(e.payment_method, '')) not in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
       and e.prepaid_advance_id is null
       and e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
       and not exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id and l.kind = 'recorded_payment')
  ),
  legs as (
    select e.id, e.zoho_doc_id as zdoc, e.zoho_leg, e.vendor_id, e.vendor_name, e.bill_no, e.category, e.expense_date,
           o.bank_account_id, o.paid_on, o.cash, (o.id is not null) as is_open
      from public.expenses e
      left join open_rows o on o.id = e.id
     where e.tenant_id = v_tenant and e.zoho_doc_id is not null
  ),
  docs0 as (
    select g.zdoc,
           count(*)::integer as n_legs,
           (count(*) filter (where g.is_open))::integer as n_open,
           count(distinct g.bank_account_id) filter (where g.is_open) as n_acc,
           count(distinct g.paid_on) filter (where g.is_open) as n_days,
           (array_agg(g.bank_account_id order by g.zoho_leg) filter (where g.is_open))[1] as acc,
           (array_agg(g.paid_on order by g.zoho_leg) filter (where g.is_open))[1] as paid_on,
           (coalesce(sum(g.cash) filter (where g.is_open), 0))::integer as cash,
           (array_agg(g.vendor_id order by g.zoho_leg))[1] as vendor_id,
           (array_agg(g.vendor_name order by g.zoho_leg))[1] as vendor_name,
           (array_agg(g.bill_no order by g.zoho_leg))[1] as bill_no,
           min(g.expense_date) as doc_date,
           string_agg(distinct g.category, ', ') as cats,
           array_agg(g.id order by g.zoho_leg) filter (where g.is_open) as ids
      from legs g
     group by g.zdoc
  ),
  docs1 as (
    select d.*, a.name as acc_name,
           /* every part open the same way, paid from ONE known account */
           (d.n_open = d.n_legs and d.n_acc = 1 and d.n_days = 1 and a.id is not null) as whole,
           /* Zoho paid 2+ bills with this one vendor payment: the debit is their TOTAL, never this bill's own cash */
           coalesce(pay.n_bills, 1) as n_bills,
           /* The bank's reference as Zoho has it: the vendor payment that paid the bill (R-2502 link),
              else the Zoho expense's own reference. A bill's own reference is a bill note, not a UTR. */
           nullif(btrim(coalesce(
             (select nullif(btrim(s.payload->>'reference'), '') from public.zoho_fy_scan s
               where s.tenant_id = v_tenant and s.kind = 'vendorpayments' and s.zoho_id = pay.zoho_payment_id),
             case when d.zdoc like 'expenses:%' then
               (select s.payload->>'reference' from public.zoho_fy_scan s
                 where s.tenant_id = v_tenant and s.kind = 'expenses' and s.zoho_id = substr(d.zdoc, 10))
             end, '')), '') as ref
      from docs0 d
      left join public.bank_accounts a on a.id = d.acc and a.tenant_id = v_tenant
      left join lateral (
        select k.zoho_payment_id,
               (select count(distinct k2.zoho_bill_id) from public.zoho_vendor_payment_links k2
                 where k2.tenant_id = v_tenant and k2.zoho_payment_id = k.zoho_payment_id) as n_bills
          from public.zoho_vendor_payment_links k
         where k.tenant_id = v_tenant and k.target_type = 'expense' and k.target_ids && d.ids
         order by k.created_at, k.id limit 1
      ) pay on true
     where d.n_open > 0 and d.cash > 0
       and coalesce(a.account_type::text, '') <> 'cash'
       and (p_account_id is null or d.acc = p_account_id)
  ),
  docs as (
    select d.*,
           /* the Zoho reference when it is shaped like a UTR / RRN (10–22 characters, 6+ digits) */
           case when length(public.bank_ref_norm(d.ref)) between 10 and 22
                 and length(regexp_replace(public.bank_ref_norm(d.ref), '[^0-9]', '', 'g')) >= 6
                then public.bank_ref_norm(d.ref) end as ref_utr
      from docs1 d
  ),
  lines as (
    /* Statement debits of the documents' accounts with a document's cash (±₹1). Never the app's own
       stand-in line of a payment recorded on the Bills page / a payment run (source 'manual' matched
       to a bill / expense) — that is not a bank debit; it counts as a rival below. */
    select bt.id, bt.bank_account_id, bt.txn_date, bt.description, bt.ref_key, bt.matched_to_type,
           coalesce(bt.debit, 0) as dr
      from public.bank_transactions bt
     where bt.tenant_id = v_tenant
       and coalesce(bt.debit, 0) > 0 and coalesce(bt.credit, 0) = 0
       and not (bt.source = 'manual' and coalesce(bt.matched_to_type, '') in ('vendor_bill', 'expense'))
       and exists (select 1 from docs d where d.acc = bt.bank_account_id and abs(coalesce(bt.debit, 0) - d.cash) <= 1)
  ),
  cand as (
    select d.zdoc, l.id as lid, l.txn_date, l.description,
           /* NULL never reads as a match (R-2656 lesson): coalesce to false */
           coalesce(length(public.bank_ref_norm(l.ref_key)) >= 6 and public.bank_ref_matches(d.ref, l.ref_key), false) as by_ref,
           /* both sides carry a UTR / RRN and they are NOT the same: another payment */
           coalesce(d.ref_utr is not null and length(public.bank_ref_norm(l.ref_key)) >= 10
                    and not public.bank_ref_matches(d.ref, l.ref_key), false) as ref_clash
      from docs d
      join lines l on l.bank_account_id = d.acc and l.matched_to_type is null and l.dr = d.cash
     where d.whole and d.n_bills = 1
       and (abs(l.txn_date - d.paid_on) <= 7
            or (abs(l.txn_date - d.paid_on) <= 60
                and coalesce(length(public.bank_ref_norm(l.ref_key)) >= 10 and public.bank_ref_matches(d.ref, l.ref_key), false)))
  ),
  per_doc as (select c.zdoc, count(*) as n_all, count(*) filter (where c.by_ref) as n_ref from cand c group by c.zdoc),
  per_line as (select c.lid, count(*) as n_all, count(*) filter (where c.by_ref) as n_ref from cand c group by c.lid),
  judged as (
    select c.*,
           (case when pd.n_ref > 0 then (c.by_ref and pd.n_ref = 1) else pd.n_all = 1 end)
           and (case when pl.n_ref > 0 then (c.by_ref and pl.n_ref = 1) else pl.n_all = 1 end) as only_one,
           (case when pd.n_ref > 0 then c.by_ref else true end)
           and (case when pl.n_ref > 0 then c.by_ref else true end) as in_play,
           greatest(pd.n_all, pl.n_all) as n_max
      from cand c
      join per_doc pd on pd.zdoc = c.zdoc
      join per_line pl on pl.lid = c.lid
  ),
  pairs as (
    select d.zdoc, j.lid, j.txn_date, j.description, j.by_ref, j.ref_clash, j.only_one, j.n_max,
           /* Something else recorded as paid that this debit could be (R-1911's two lists, ±30 days as
              bank_debit_vendor_auto_match): (b) another open paid expense of the same cash — from Zoho
              or not — that is not already counted as a candidate of this line; (a) a payment recorded
              on the Bills page / a payment run (its stand-in manual line) of the same amount. */
           (exists (select 1 from open_rows r
                     where r.cash = d.cash
                       and (r.bank_account_id is null or r.bank_account_id = d.acc)
                       and abs(r.paid_on - j.txn_date) <= 30
                       and (r.zdoc is null
                            or (r.zdoc <> d.zdoc
                                and not exists (select 1 from cand c2 where c2.zdoc = r.zdoc and c2.lid = j.lid))))
            or exists (select 1 from public.bank_transactions m
                        where m.tenant_id = v_tenant and m.bank_account_id = d.acc
                          and m.source = 'manual' and m.matched_to_type in ('vendor_bill', 'expense')
                          and coalesce(m.debit, 0) = d.cash and abs(m.txn_date - j.txn_date) <= 30)
           ) as rival
      from judged j
      join docs d on d.zdoc = j.zdoc
     where j.in_play
  ),
  paired as (
    select d.*, p.lid, p.txn_date as l_date, p.description as l_desc,
           case when p.only_one is not true or p.rival then 'ambiguous'
                when v_lock is not null and least(p.txn_date, d.paid_on) <= v_lock then 'locked'
                when p.ref_clash then 'look'
                else 'sure' end as st,
           case when p.only_one is not true then
                  format('%s documents / debits of this amount could pair here — nothing is matched when there is more than one. Match it on the bank line.', p.n_max)
                when p.rival then
                  'Another paid expense of the same amount (not reconciled yet), or a payment recorded on the Bills page, could be this debit too. Match it on the bank line.'
                when v_lock is not null and least(p.txn_date, d.paid_on) <= v_lock then
                  format('Books are locked up to %s.', to_char(v_lock, 'DD Mon YYYY'))
                when p.ref_clash then
                  'Same amount, but the bank reference on the debit is not the one Zoho has for this payment — it may be another payment. Check it and match it on the bank line.'
                else
                  case when p.by_ref then 'Same bank reference as in Zoho, same amount' else 'Same amount' end
                  || format(', paid from this account, %s day(s) apart, the only open debit and the only Zoho document that fit.', abs(p.txn_date - d.paid_on))
           end as why
      from pairs p
      join docs d on d.zdoc = p.zdoc
  ),
  alone as (
    /* a document with no pair in play: say why (the first that applies) */
    select d.*, x.lid, x.l_date, x.l_desc, x.st, x.why
      from docs d
      cross join lateral (
        select * from (
          /* 0. its parts are not all open the same way, or it has no paid-from account */
          select 0 as pri, null::uuid as lid, null::date as l_date, null::text as l_desc, 'look'::text as st,
                 case when d.acc is null then
                        'Marked paid with no paid-from account — it cannot be matched to an account''s lines here. Match it on the bank line.'
                      else format('%s of its %s parts are open, or its parts were paid from different accounts / dates — it was changed by hand. Match it on the bank line.', d.n_open, d.n_legs)
                 end as why
           where not d.whole
          union all
          /* 1. Zoho paid several bills with one payment */
          select 1, null::uuid, null::date, null::text, 'look',
                 format('Zoho paid this bill together with %s other bill(s) in one payment — the bank debit is their total, not this amount. Match it on the bank line.', d.n_bills - 1)
           where d.whole and d.n_bills > 1
          union all
          /* 2. its only open debit carries another Zoho document's reference */
          select 2, t.lid, t.txn_date, t.description, 'look',
                 'The open debit of this amount carries the bank reference of another Zoho document — it belongs to that one.'
            from (select c.* from cand c where c.zdoc = d.zdoc order by abs(c.txn_date - d.paid_on), c.lid limit 1) t
          union all
          /* 3. the same-amount debit is already reconciled as something else — not as a Zoho document's
                own recorded payment (a sibling document matched correctly is not a double expense) */
          select 3, b.id, b.txn_date, b.description, 'booked_elsewhere',
                 format('A debit of the same amount on %s is already reconciled as %s. If that is this payment, the expense is in the books twice — check it.',
                        to_char(b.txn_date, 'DD Mon YYYY'), replace(b.matched_to_type, '_', ' '))
            from (select l.* from lines l
                   where l.bank_account_id = d.acc and l.matched_to_type is not null and l.dr = d.cash
                     and abs(l.txn_date - d.paid_on) <= 7
                     and not exists (select 1 from public.expenses z
                                      where z.tenant_id = v_tenant and z.zoho_doc_id is not null and z.reconciled_txn_id = l.id)
                     and not exists (select 1 from public.bank_vendor_payment_lines pl
                                      join public.expenses z on z.id = pl.expense_id and z.tenant_id = v_tenant
                                     where pl.bank_txn_id = l.id and pl.kind = 'recorded_payment' and z.zoho_doc_id is not null)
                   order by abs(l.txn_date - d.paid_on), l.id limit 1) b
           where d.whole and d.n_bills = 1
          union all
          /* 4. an open debit ₹1 apart */
          select 4, n.id, n.txn_date, n.description, 'look',
                 'The debit is ₹1 apart from what Zoho paid — the same money, but it is not matched automatically. Match it on the bank line.'
            from (select l.* from lines l
                   where l.bank_account_id = d.acc and l.matched_to_type is null and abs(l.dr - d.cash) = 1
                     and abs(l.txn_date - d.paid_on) <= 7
                   order by abs(l.txn_date - d.paid_on), l.id limit 1) n
           where d.whole and d.n_bills = 1
          union all
          /* 5. an open same-amount debit outside the window */
          select 5, f.id, f.txn_date, f.description, 'no_line',
                 format('No open debit of this amount within 7 days of %s. The nearest one is on %s (%s days away) — check it is the same payment and match it on the bank line.',
                        to_char(d.paid_on, 'DD Mon YYYY'), to_char(f.txn_date, 'DD Mon YYYY'), abs(f.txn_date - d.paid_on))
            from (select l.* from lines l
                   where l.bank_account_id = d.acc and l.matched_to_type is null and l.dr = d.cash
                     and abs(l.txn_date - d.paid_on) between 8 and 60
                   order by abs(l.txn_date - d.paid_on), l.id limit 1) f
           where d.whole and d.n_bills = 1
          union all
          /* 6. nothing */
          select 6, null::uuid, null::date, null::text, 'no_line',
                 format('No open debit of this amount within 7 days of %s in this account — is the statement imported up to that date?',
                        to_char(d.paid_on, 'DD Mon YYYY'))
           where d.whole and d.n_bills = 1
        ) y order by y.pri limit 1
      ) x
     where not exists (select 1 from pairs p where p.zdoc = d.zdoc)
  )
  select r.st, r.why, r.zdoc, r.vendor_id, r.vendor_name, r.bill_no, r.cats,
         r.doc_date, r.paid_on, r.cash, r.n_open, r.ids, r.ref,
         r.acc, r.acc_name, r.lid, r.l_date, r.l_desc
    from (select * from paired union all select * from alone) r
   order by case r.st when 'sure' then 0 when 'ambiguous' then 1 when 'look' then 2 when 'booked_elsewhere' then 3
                      when 'locked' then 4 else 5 end,
            r.paid_on, r.zdoc, r.lid;
end;
$function$;
revoke all on function public.zoho_expense_bank_matches(uuid) from public, anon;
grant execute on function public.zoho_expense_bank_matches(uuid) to authenticated, service_role;

-- ── 4. Book as expense: the zoho-covered guard ← 20261111222942_r2680 ────────────────────────
CREATE OR REPLACE FUNCTION public.book_bank_txn_as_expense(p_txn_id uuid, p_category text, p_vendor text, p_gst integer, p_notes text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_exp_id text;
  v_vendor text := nullif(trim(coalesce(p_vendor, '')), '');
  v_vid    uuid;
  v_vname  text;
  v_found  boolean := false;
  v_item   record;
  v_z_who  text;
  v_z_what text;
  v_z_on   date;
  v_z_cash integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can book a bank line' using errcode = '42501';
  end if;
  if trim(coalesce(p_category, '')) = '' then
    raise exception 'Please choose a category';
  end if;
  /* R-2611: locked — a second booking of the same line waits here, then sees it reconciled. */
  select * into v_txn from public.bank_transactions
    where id = p_txn_id and tenant_id = v_tenant
    for update;
  if not found then raise exception 'Transaction not found'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then
    raise exception 'Only a money-out (debit) line can be booked as an expense';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  /* R-1917 (B8): the vendor's open item of this amount is PAID with this line (Record payment),
     never booked a second time as a new expense. */
  if v_vendor is not null then
    for v_vid, v_vname in
      select v.id, v.name from public.vendors v
       where v.tenant_id = v_txn.tenant_id and upper(trim(v.name)) = upper(v_vendor)
    loop
      v_found := true;
      select i.* into v_item
        from public.bank_debit_vendor_open_items(v_vid) i
       where i.amount_due = v_txn.debit
          or (i.source <> 'recorded_payment' and i.amount_due - coalesce(i.tds_amount, 0) = v_txn.debit)
       order by (i.source = 'recorded_payment') desc, i.doc_date, i.doc_id
       limit 1;
      if v_item.doc_id is not null then
        if v_item.source = 'recorded_payment' then
          raise exception '% bill % — ₹% is already recorded as paid (%). Match this bank line to that payment with "Record payment" instead of booking a new expense, or the cost is counted twice.',
            v_vname, coalesce(v_item.bill_no, v_item.pays_doc_id), to_char(v_item.amount_due, 'FM99,99,99,99,999'), to_char(v_item.paid_on, 'DD Mon YYYY')
            using errcode = 'P0001', hint = 'R-1917';
        end if;
        raise exception '% has an open bill % for ₹%. Pay it with "Record payment" on this line instead of booking a new expense, or the cost is counted twice.',
          v_vname, coalesce(v_item.bill_no, v_item.doc_id), to_char(v_item.amount_due, 'FM99,99,99,99,999')
          using errcode = 'P0001', hint = 'R-1917';
      end if;
    end loop;

    /* A bill typed only as a name (no vendor record): same rule, by the name. */
    if not v_found then
      select x.bill_no, x.doc_id, x.amount_due into v_item from (
        select e.bill_no, e.id as doc_id, e.amount as amount_due, e.expense_date as d
          from public.expenses e
         where e.tenant_id = v_txn.tenant_id and e.vendor_id is null
           and upper(trim(coalesce(e.vendor_name, ''))) = upper(v_vendor)
           and e.paid = false and e.reconciled_txn_id is null and e.prepaid_advance_id is null
           and (e.amount = v_txn.debit or e.amount - coalesce(e.tds_amount, 0) = v_txn.debit)
        union all
        select b.bill_no, b.id, b.total - coalesce(b.paid_amount, 0), b.bill_date
          from public.vendor_bills b
         where b.tenant_id = v_txn.tenant_id and b.vendor_id is null
           and upper(trim(b.vendor_name)) = upper(v_vendor)
           and coalesce(b.status, 'unpaid') <> 'paid'
           and b.total - coalesce(b.paid_amount, 0) = v_txn.debit
      ) x order by x.d, x.doc_id limit 1;
      if v_item.doc_id is not null then
        raise exception '% has an open bill % for ₹%. Pay it with "Record payment" on this line instead of booking a new expense, or the cost is counted twice.',
          v_vendor, coalesce(v_item.bill_no, v_item.doc_id), to_char(v_item.amount_due, 'FM99,99,99,99,999')
          using errcode = 'P0001', hint = 'R-1917';
      end if;
    end if;
  end if;

  /* R-2680 zoho-covered guard (money rule S9 — S7's sheet rule on the server). Runs AFTER R-1917: when a
     vendor is typed and R-1917 knows the open bill / recorded payment, its sentence answers first.
     A purchase imported from Zoho that has no bank line yet is tied to its debit, never booked as a
     new expense — the cost (and its GST) would be counted twice. What ONE debit can be:
       paid    — a Zoho expense document paid from THIS account that no Zoho vendor payment is linked
                 to (all its category rows; cash = Σ amount − TDS − advance applied − bank parts paid;
                 the R-1911 "recorded payment" list, as R-2655's preview reads it), within 7 days of
                 its paid date;
       payment — the document(s) one Zoho vendor payment paid, as ONE debit: the payment's own amount
                 in Zoho when the scan has it (it may carry an advance or a bill kept elsewhere), else
                 the sum of its open documents. A bill inside a payment is never a unit by itself —
                 refusing an unrelated debit of the bill's amount would send the user to tie the wrong
                 line and free the payment's real debit;
       bill    — an UNPAID Zoho bill kept as expense rows, or an unpaid / part-paid Zoho COGS bill (what
                 is still due, with and without its Zoho TDS): from 7 days before the bill date to 120
                 days after it (S7's window), from any account. Its own sentence: a bill is PAID with
                 "Record payment" — matching a line to it does not pay it.
     Same amount ±₹1 (S1). ONE document covers at most ONE line (S7): this line is refused only while it
     is among the nearest open debits of this account for the documents it fits (as many lines as there
     are such documents; ties by line id). A later posting: up to 60 days after a paid document when the
     line's own UTR / RRN (10+ characters) is the reference Zoho has for that payment. NULL is never a
     match. Live state only. Speed: the documents (±60 days) are read once, each bill's payment is one
     index probe, and Zoho's reference is looked up only for the few that fit the amount. */
  with open_paid as (
    select e.id, e.zoho_doc_id as zdoc, e.zoho_leg, e.vendor_name, e.category,
           coalesce(e.paid_date, e.expense_date) as paid_on,
           e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) as cash
      from public.expenses e
     where e.tenant_id = v_txn.tenant_id
       and e.zoho_doc_id is not null
       and e.bank_account_id = v_txn.bank_account_id
       and e.paid = true and e.reconciled_txn_id is null
       and coalesce(e.paid_date, e.expense_date) between v_txn.txn_date - 60 and v_txn.txn_date + 60
       and upper(coalesce(e.currency, 'INR')) = 'INR'
       and (e.category <> 'Salaries' or e.zoho_doc_id is not null)   -- R-2913: a Zoho-imported salary covers its debit too
       and lower(coalesce(e.payment_method, '')) not in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
       and e.prepaid_advance_id is null
       and e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
       and not exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id and l.kind = 'recorded_payment')
  ),
  docs0 as (
    select o.zdoc,
           coalesce(nullif(btrim((array_agg(o.vendor_name order by o.zoho_leg))[1]), ''), (array_agg(o.category order by o.zoho_leg))[1]) as who,
           min(o.paid_on) as paid_on, sum(o.cash)::integer as cash
      from open_paid o
     group by o.zdoc
  ),
  docs as (
    /* which Zoho vendor payment paid the bill (R-2502 links: one row per payment + Zoho bill id; an
       imported bill's zoho_doc_id is 'bills:<that id>') — one index probe per document
       (zoho_vendor_payment_links_bill_idx: tenant_id, zoho_bill_id) */
    select d.*,
           case when d.zdoc like 'bills:%' then
             (select min(lk.zoho_payment_id) from public.zoho_vendor_payment_links lk
               where lk.tenant_id = v_txn.tenant_id and lk.zoho_bill_id = substr(d.zdoc, 7) and lk.target_type = 'expense')
           end as pay_id
      from docs0 d
  ),
  pays as (
    select d.pay_id, (array_agg(d.who order by d.zdoc))[1] as who, min(d.paid_on) as paid_on,
           sum(d.cash)::integer as open_sum, count(*)::integer as n
      from docs d
     where d.pay_id is not null
     group by d.pay_id
  ),
  units as (
    /* paid: a document no Zoho vendor payment is linked to */
    select d.zdoc as k, d.who, 'paid'::text as what, d.paid_on as anchor, d.cash,
           d.paid_on - 7 as d_from, d.paid_on + 7 as d_to,
           case when d.zdoc like 'expenses:%' then 'expenses' end as ref_kind, substr(d.zdoc, 10) as ref_id
      from docs d
     where d.pay_id is null
    union all
    /* payment: what one Zoho vendor payment paid, as one debit */
    select 'payment:' || p.pay_id,
           p.who || case when p.n > 1 then ' and ' || (p.n - 1) || ' more bill' || case when p.n > 2 then 's' else '' end else '' end
                 || case when pa.amount is distinct from p.open_sum and pa.amount is not null then ' (one Zoho payment)' else '' end,
           'paid', p.paid_on, coalesce(pa.amount, p.open_sum), p.paid_on - 7, p.paid_on + 7, 'vendorpayments', p.pay_id
      from pays p
      left join public.zoho_fy_scan sc on sc.tenant_id = v_txn.tenant_id and sc.kind = 'vendorpayments' and sc.zoho_id = p.pay_id
      cross join lateral (select case when coalesce(sc.payload->>'amount', '') ~ '^[0-9]+(\.[0-9]+)?$'
                                      then round((sc.payload->>'amount')::numeric)::integer end as amount) pa
    union all
    /* bill: an unpaid Zoho bill kept as expense rows */
    select e.zoho_doc_id, coalesce(nullif(btrim((array_agg(e.vendor_name order by e.zoho_leg))[1]), ''), (array_agg(e.category order by e.zoho_leg))[1]),
           'bill', min(e.expense_date),
           sum(e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0))::integer,
           min(e.expense_date) - 7, min(e.expense_date) + 120, null::text, null::text
      from public.expenses e
     where e.tenant_id = v_txn.tenant_id and e.zoho_doc_id like 'bills:%'
       and e.paid = false and e.reconciled_txn_id is null and e.prepaid_advance_id is null
       and upper(coalesce(e.currency, 'INR')) = 'INR'
       and e.expense_date between v_txn.txn_date - 120 and v_txn.txn_date + 7
     group by e.zoho_doc_id
    union all
    /* bill: an unpaid / part-paid Zoho COGS bill — what is due, with and without its Zoho TDS */
    select vb.zoho_doc_id || t.tag, coalesce(nullif(btrim(vb.vendor_name), ''), vb.category), 'bill', vb.bill_date,
           (vb.total - coalesce(vb.paid_amount, 0) - t.tds)::integer, vb.bill_date - 7, vb.bill_date + 120, null::text, null::text
      from public.vendor_bills vb
      cross join lateral (
        select ''::text as tag, 0 as tds
        union all
        select ':tds', coalesce(vb.zoho_tds_amount, 0) where coalesce(vb.zoho_tds_amount, 0) > 0 and coalesce(vb.paid_amount, 0) = 0
      ) t
     where vb.tenant_id = v_txn.tenant_id and vb.zoho_doc_id is not null
       and coalesce(vb.status, 'unpaid') <> 'paid'
       and upper(coalesce(vb.currency, 'INR')) = 'INR'
       and vb.total - coalesce(vb.paid_amount, 0) > 0
       and vb.bill_date between v_txn.txn_date - 120 and v_txn.txn_date + 7
  ),
  mine as materialized (
    /* the few documents with this line's amount — only for these is Zoho's reference looked up */
    select u.*, abs(u.anchor - v_txn.txn_date) as gap,
           coalesce(u.what = 'paid' and u.ref_kind is not null and abs(u.anchor - v_txn.txn_date) <= 60
                    and length(public.bank_ref_norm(v_txn.ref_key)) >= 10
                    and public.bank_ref_matches(
                          (select nullif(btrim(sc.payload->>'reference'), '') from public.zoho_fy_scan sc
                            where sc.tenant_id = v_txn.tenant_id and sc.kind = u.ref_kind and sc.zoho_id = u.ref_id),
                          v_txn.ref_key), false) as by_ref
      from units u
     where u.cash > 0 and abs(u.cash - v_txn.debit) <= 1
  ),
  fit as (
    select m.* from mine m
     where m.by_ref or v_txn.txn_date between m.d_from and m.d_to
  ),
  better as (
    /* other OPEN debits of this account that fit one of those documents and are nearer to it */
    select count(distinct o.id) as n
      from public.bank_transactions o
      join fit m on abs(m.cash - o.debit) <= 1 and o.txn_date between m.d_from and m.d_to
     where o.tenant_id = v_txn.tenant_id and o.bank_account_id = v_txn.bank_account_id and o.id <> v_txn.id
       and o.debit between v_txn.debit - 2 and v_txn.debit + 2
       and coalesce(o.credit, 0) = 0 and o.matched_to_type is null
       and (abs(m.anchor - o.txn_date), o.id) < ((select min(f.gap) from fit f), v_txn.id)
  )
  select f.who, f.what, f.anchor, f.cash
    into v_z_who, v_z_what, v_z_on, v_z_cash
    from fit f
   where f.by_ref
      or (select b.n from better b) < (select count(*) from fit)
   order by f.by_ref desc, f.gap, (f.what = 'paid') desc, f.k
   limit 1;
  if v_z_cash is not null and v_z_what = 'bill' then
    raise exception 'This debit looks like the payment of a bill already imported from Zoho (%, bill dated %, ₹%). Pay that bill with "Record payment" on this line instead of booking a new expense, or the cost is counted twice.',
      v_z_who, to_char(v_z_on, 'DD Mon YYYY'), to_char(v_z_cash, 'FM99,99,99,99,999')
      using errcode = 'P0001', hint = 'R-2680';
  elsif v_z_cash is not null then
    raise exception 'This debit looks like a purchase already imported from Zoho (%, paid %, ₹%). Match the line to it in Reconcile instead of booking a new expense, or the cost is counted twice.',
      v_z_who, to_char(v_z_on, 'DD Mon YYYY'), to_char(v_z_cash, 'FM99,99,99,99,999')
      using errcode = 'P0001', hint = 'R-2680';
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description,
     paid, paid_date, bank_account_id, reconciled_txn_id)
  values
    (v_exp_id, v_tenant, trim(p_category), v_vendor,
     v_txn.txn_date, v_txn.debit, greatest(coalesce(p_gst, 0), 0), 'bank',
     coalesce(nullif(trim(coalesce(p_notes, '')), ''), v_txn.description),
     true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id);
  update public.bank_transactions
     set matched_to_type = 'expense', matched_to_id = v_exp_id, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid()
   where id = p_txn_id and tenant_id = v_tenant
     and matched_to_type is null;   -- R-2611: never over another booking
  if not found then
    raise exception 'This line is already reconciled' using errcode = 'P0001', hint = 'R-2611';
  end if;
  return v_exp_id;
end;
$function$
;

-- ── 5. Suggestions on a bank line ← 20261107205640_r2192 ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.suggest_bank_transaction_matches(p_bank_txn_id uuid)
 RETURNS TABLE(match_type text, match_id text, match_label text, match_amount integer, match_date date, match_confidence text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_txn record; v_tenant uuid; v_search_amount integer; v_is_credit boolean;
  v_caller uuid; v_trusted boolean; v_known uuid; v_payer_customers uuid[]; v_ref text;
begin
  /* R-715: a signed-in caller sees suggestions only for their own company's bank line.
     R-2534: trusted check through public.current_request_role() (R-2487 scan: no new raw auth list).
     No company (null-caller) → refused; another company's line → nothing (as "not found"). */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '42501';
  end if;
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  if not v_trusted and v_txn.tenant_id is distinct from v_caller then return; end if;
  v_tenant := v_txn.tenant_id; v_search_amount := greatest(v_txn.debit, v_txn.credit); v_is_credit := v_txn.credit > 0;
  /* R-2534: the line's own UTR / RRN — a cheque number (under 10 characters) never ranks a receipt. */
  v_ref := case when length(v_txn.ref_key) >= 10 then v_txn.ref_key end;
  if v_is_credit then
    /* R-2364: who paid — the line's own payer answer (R-2025), else exactly one customer with a
       known payer whose key EQUALS one dash/slash part of the narration (the rails' name slots —
       "NEFT CR-<IFSC>-GIBI PAUL-<us>-<UTR>"; customer-payer.ts knownPayerCustomer's equality,
       never a loose word hit). Two customers → no guess. */
    if coalesce(v_txn.payer->>'customer_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select c.id into v_known from public.customers c
       where c.id = (v_txn.payer->>'customer_id')::uuid and c.tenant_id = v_tenant;
    end if;
    if v_known is null then
      select array_agg(distinct cp.customer_id) into v_payer_customers
        from public.customer_payers cp
       where cp.tenant_id = v_tenant
         and cp.payer_name_key in (select public.payer_name_key(part)
                                     from regexp_split_to_table(coalesce(v_txn.description, ''), '[-/]') part);
      if cardinality(v_payer_customers) = 1 then v_known := v_payer_customers[1]; end if;
    end if;

    /* R-2534: receipts and project receipts in ONE ranked list (each kind still at most 5), so a
       referenced project receipt ranks above an unreferenced payment — auto_reconcile reads the top
       two of the whole result. With no reference match: the R-2364 order and confidences exactly. */
    return query
    with pay as (
      select 'payment'::text as kind, p.id::text as mid, p.customer_id, p.received_at::date as d, (p.amount - p.credit_applied) as amt,
             coalesce(c.name, p.receipt_voucher_no, 'Payment') || case when p.reference is not null and p.reference <> '' then ' · ' || p.reference else '' end as label,
             (v_ref is not null and public.bank_ref_matches(p.reference, v_ref)) as by_ref
        from public.payments p left join public.customers c on c.id = p.customer_id
       -- R-1565: the bank saw only the cash part; a payment paid wholly by advance credit is never suggested.
       where p.tenant_id = v_tenant and p.status = 'received' and (p.amount - p.credit_applied) > 0
         and abs((p.amount - p.credit_applied) - v_search_amount) <= 100
         -- R-2534: 7 days by amount; up to 60 days when the reference is the line's own.
         and (abs(p.received_at::date - v_txn.txn_date) <= 7
              or (v_ref is not null and abs(p.received_at::date - v_txn.txn_date) <= 60
                  and public.bank_ref_matches(p.reference, v_ref)))
         -- R-2364: never a receipt another bank line already carries …
         and not exists (select 1 from public.bank_transactions t
                          where t.tenant_id = v_tenant and t.id <> v_txn.id
                            and t.matched_to_type = 'payment' and t.matched_to_id = p.id::text)
         -- … nor one a reconciled split line holds (R-2098) …
         and not (p.bank_txn_id is not null and p.bank_txn_id <> v_txn.id
                  and exists (select 1 from public.bank_transactions t2
                               where t2.id = p.bank_txn_id and t2.tenant_id = v_tenant and t2.matched_to_type is not null))
         -- … nor one created from another line (BANK-<line id>) while that line is reconciled (un-reconciled
         -- → the receipt is free again, e.g. a duplicate import kept as undeposited).
         and not (coalesce(p.reference, '') ~* '^BANK-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  and lower(substr(p.reference, 6)) <> v_txn.id::text
                  and exists (select 1 from public.bank_transactions t3
                               where t3.id = lower(substr(p.reference, 6))::uuid and t3.tenant_id = v_tenant
                                 and t3.matched_to_type is not null))
    ), proj as (
      select 'project'::text as kind, pp.id::text as mid, null::uuid as customer_id, pp.received_at::date as d, pp.amount as amt,
             coalesce(ps.customer_name, ps.title, 'Project payment') || ' · project' as label,
             (v_ref is not null and public.bank_ref_matches(pp.reference, v_ref)) as by_ref
        from public.project_payments pp
        join public.project_sales ps on ps.id = pp.project_id
       where pp.tenant_id = v_tenant and pp.bank_txn_id is null
         and abs(pp.amount - v_search_amount) <= 100
         and (abs(pp.received_at::date - v_txn.txn_date) <= 7
              or (v_ref is not null and abs(pp.received_at::date - v_txn.txn_date) <= 60
                  and public.bank_ref_matches(pp.reference, v_ref)))
    ), allc as (
      select * from pay union all select * from proj
    ), ranked as (
      select a.*, (a.by_ref and a.amt = v_search_amount) as ref_exact,
             bool_or(a.by_ref and a.amt = v_search_amount) over () as any_ref_exact,
             bool_or(a.amt = v_search_amount) over () as any_equal,   -- R-2192
             row_number() over (partition by a.kind
                                order by (a.by_ref and a.amt = v_search_amount) desc,
                                         (a.kind = 'payment' and coalesce(a.customer_id = v_known, false)) desc,
                                         abs(a.amt - v_search_amount), abs(a.d - v_txn.txn_date)) as rn
        from allc a
    )
    select r.kind, r.mid, r.label, r.amt, r.d,
           case when r.ref_exact then 'exact'
                when r.kind = 'payment' and v_known is not null and r.customer_id is distinct from v_known then 'low'
                when abs(r.d - v_txn.txn_date) > 7 then 'low'
                -- R-2534: another receipt carries the line's reference → this one is at most 'high'.
                when r.amt = v_search_amount and r.d = v_txn.txn_date and not r.any_ref_exact then 'exact'
                when r.amt = v_search_amount and abs(r.d - v_txn.txn_date) <= 3 then 'high'
                -- R-2192: a receipt within ₹1 of the line is the same money (sameMoney) — 'high' when no
                -- candidate has the exact amount (never 'exact'; an exact one still wins alone).
                when r.kind = 'payment' and abs(r.amt - v_search_amount) <= 1 and not r.any_equal
                     and abs(r.d - v_txn.txn_date) <= 3 then 'high'
                else 'low' end::text
      from ranked r
     where r.rn <= 5
     order by r.ref_exact desc, (r.kind = 'project'), r.rn;
  end if;
  if not v_is_credit then
    return query
    select 'salary'::text, sp.id::text, e.name || ' · salary ' || sp.period, sp.net, sp.pay_date,
           case when sp.net = v_search_amount and sp.pay_date = v_txn.txn_date then 'exact'
                when sp.net = v_search_amount and abs(sp.pay_date - v_txn.txn_date) <= 10 then 'high' else 'low' end::text
    from public.salary_payments sp join public.employees e on e.id = sp.employee_id
    where sp.tenant_id = v_tenant and sp.paid_status = 'unpaid' and abs(sp.net - v_search_amount) <= 100 and abs(sp.pay_date - v_txn.txn_date) <= 15
    order by abs(sp.net - v_search_amount), abs(sp.pay_date - v_txn.txn_date) limit 5;
    return query
    select 'expense'::text, e.id::text, coalesce(e.vendor_name, e.category, 'Expense'), e.amount, e.expense_date,
           case when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
                when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.expenses e
    -- R-2913: Payroll's Salaries rows are offered as 'salary' above; a salary imported from Zoho
    -- (zoho_doc_id) has no payslip, so it is offered as the expense it is.
    where e.tenant_id = v_tenant and (e.category <> 'Salaries' or e.zoho_doc_id is not null) and abs(e.amount - v_search_amount) <= 100 and abs(e.expense_date - v_txn.txn_date) <= 7
      -- R-2364: never an expense already reconciled to another bank line (R-2325's browser rule).
      and (e.reconciled_txn_id is null or e.reconciled_txn_id = v_txn.id)
      and not exists (select 1 from public.bank_transactions t
                       where t.tenant_id = v_tenant and t.id <> v_txn.id
                         and t.matched_to_type = 'expense' and t.matched_to_id = e.id)
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date) limit 5;
  end if;
end; $function$;
revoke all on function public.suggest_bank_transaction_matches(uuid) from public, anon;
grant execute on function public.suggest_bank_transaction_matches(uuid) to authenticated, service_role;

commit;
