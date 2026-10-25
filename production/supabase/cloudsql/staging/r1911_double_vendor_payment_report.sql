-- R-1911: POSSIBLE DOUBLE VENDOR PAYMENTS — a payment recorded outside the bank (Bills page Pay /
-- payment run = a manual bank line; Expenses → Mark paid = no bank line) AND a real bank line booked
-- for the same money (R-1866 "This payment is for:" / R-1867 auto-reconcile / an advance), so the
-- vendor shows paid twice and the bank shows the cash out twice (R-1906 audit B1).
--
-- READ-ONLY REPORT. One SELECT; it changes nothing. Whether a row is a real double and how to
-- repair it is Pardeep's decision (data repairs stay with the owner). Run it on the LOCAL DB to
-- try it; the manager runs it on staging (e.g. `gcloud sql export csv --query`, like
-- scripts/ops/r1708-dues-drift-report.sql). Each row is a CANDIDATE — two genuine payments of the
-- same amount to one bill look the same; open the bill and the bank statement before acting.
--
-- Columns:
--   kind            bill_paid_twice   — a bill with a manual (Bills page / payment run) line AND a
--                                       bank line that paid it again (R-1866/R-1867 kind 'bill') for
--                                       the same amount;
--                   bill_line_twice   — a bill with a manual line AND an imported bank line matched
--                                       straight to it (matched_to_type 'vendor_bill') for the same amount;
--                   bill_over_total   — a bill whose paid amount is above its total;
--                   expense_and_advance — an expense marked paid with no bank line AND, within 30 days,
--                                       a bank line kept as an ADVANCE to the same vendor for the same cash.
--   tenant_id, vendor, doc_id (bill / expense), bill_no, doc_total, paid_amount,
--   recorded_on / recorded_amount  — the outside-the-bank payment,
--   bank_txn_id / bank_date / bank_amount / bank_text — the real bank line booked for it,
--   bank_matched_at — when that bank line was booked (R-1867 auto-reconcile went on staging 24 Oct 2026).
select x.* from (
  -- 1. Bills page / payment run line + R-1866/R-1867 bank payment of the same amount.
  select 'bill_paid_twice'::text as kind, b.tenant_id, b.vendor_name as vendor, b.id as doc_id, b.bill_no,
         b.total as doc_total, b.paid_amount,
         m.txn_date as recorded_on, m.debit as recorded_amount,
         t.id as bank_txn_id, t.txn_date as bank_date, (l.cash + l.tds_amount) as bank_amount, t.description as bank_text,
         t.matched_at as bank_matched_at
    from public.vendor_bills b
    join public.bank_transactions m
      on m.tenant_id = b.tenant_id and m.source = 'manual' and m.matched_to_type = 'vendor_bill' and m.matched_to_id = b.id
    join public.bank_vendor_payment_lines l
      on l.tenant_id = b.tenant_id and l.vendor_bill_id = b.id and l.kind = 'bill'
     and (l.cash + l.tds_amount = m.debit or l.cash = m.debit)
    join public.bank_transactions t on t.id = l.bank_txn_id
  union all
  -- 2. Bills page / payment run line + an imported line matched straight to the bill, same amount.
  select 'bill_line_twice', b.tenant_id, b.vendor_name, b.id, b.bill_no, b.total, b.paid_amount,
         m.txn_date, m.debit, t.id, t.txn_date, t.debit, t.description, t.matched_at
    from public.vendor_bills b
    join public.bank_transactions m
      on m.tenant_id = b.tenant_id and m.source = 'manual' and m.matched_to_type = 'vendor_bill' and m.matched_to_id = b.id
    join public.bank_transactions t
      on t.tenant_id = b.tenant_id and t.id <> m.id and t.source <> 'manual'
     and t.matched_to_type = 'vendor_bill' and t.matched_to_id = b.id and t.debit = m.debit
  union all
  -- 3. A bill paid above its total (whatever the path).
  select 'bill_over_total', b.tenant_id, b.vendor_name, b.id, b.bill_no, b.total, b.paid_amount,
         null::date, null::integer, null::uuid, null::date, null::integer, null::text, null::timestamptz
    from public.vendor_bills b
   where coalesce(b.paid_amount, 0) > coalesce(b.total, 0)
  union all
  -- 4. Expenses → Mark paid (no bank line) + a bank line kept as an advance to the same vendor.
  select 'expense_and_advance', e.tenant_id, coalesce(v.name, e.vendor_name), e.id, e.bill_no, e.amount, e.amount,
         coalesce(e.paid_date, e.expense_date), e.amount - coalesce(e.tds_amount, 0),
         t.id, t.txn_date, l.cash, t.description, t.matched_at
    from public.expenses e
    join public.bank_vendor_payment_lines l
      on l.tenant_id = e.tenant_id and l.kind = 'advance'
     and (l.vendor_id = e.vendor_id
          or (e.vendor_id is null and exists (select 1 from public.vendors v2 where v2.id = l.vendor_id
                                               and upper(trim(v2.name)) = upper(trim(coalesce(e.vendor_name, ''))))))
     and l.cash = e.amount - coalesce(e.tds_amount, 0)
    join public.bank_transactions t on t.id = l.bank_txn_id
    left join public.vendors v on v.id = l.vendor_id
   where e.paid = true and e.reconciled_txn_id is null
     and lower(coalesce(e.payment_method, '')) not in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
     and abs(t.txn_date - coalesce(e.paid_date, e.expense_date)) <= 30
) x
order by x.tenant_id, x.kind, x.doc_id, x.bank_date;
