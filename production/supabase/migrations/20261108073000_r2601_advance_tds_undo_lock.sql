-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_vendor_payment_line_unmatched()') and prosrc like '%R-2601%')
-- deploy-key: r2601advancetdsundolock
-- 20261108073000_r2601_advance_tds_undo_lock.sql
--
-- R-2601 (8 Nov 2026, p0 — R-1916 independent review BLOCK): un-reconciling a bank line whose
-- vendor ADVANCE carries TDS is refused once that TDS month is deposited by challan.
--
-- ─── THE GAP ─────────────────────────────────────────────────────────────────────────────────
--   R-1916 lets an advance paid from the bank withhold TDS (the 'advance' row of
--   bank_vendor_payment_lines carries tds_amount / tds_on, read by TDS payable and the 26Q).
--   The un-reconcile trigger's R-1920 lock — "a leg whose TDS month is already deposited by
--   challan is refused" — checked only kinds expense / new_expense / bill / new_bill. So undoing
--   an advance line deleted the advance and its TDS row after that TDS was paid to the
--   government: the challan was left with no deduction behind it (rule R-1920).
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────
--   tg_vendor_payment_line_unmatched — from its LATEST body (R-2335, 20261101071500; R-1916 and
--   R-2588 did not redefine it) with kind 'advance' added to the R-1920 lock: month = the
--   advance row's tds_on (the bank date it was deducted), same refusal + HINT (the challan's
--   Banking page). The Undo preview (vendor_payment_undo_preview, R-1920) runs this same trigger
--   in a rolled-back savepoint, so it shows the same block with no change of its own.
--   Nothing else in the body changes. Stored data is not changed.
-- Test: supabase/tests/r2601_advance_tds_undo_lock.test.sql

begin;

-- ── tg_vendor_payment_line_unmatched (from R-2335) — advance TDS joins the deposited-month lock ──
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
  v_href text;
  v_month date;
  v_doc  text;
begin
  /* R-1913. R-1915: an expense bill's bank part comes off its paid_amount; latest part first.
     R-1914: the advance-used sentence names the Bills page too (COGS bills take advances).
     R-1920: every refusal carries a HINT (the page to fix it on) for the Undo preview, and a
     leg whose TDS month is already deposited by challan is refused.
     R-2321: a NEW expense bill can now be part-paid by its line; undoing that line deletes the bill,
     so it is refused while anything else settled the rest (another bank line — the R-1912 check —
     or Mark paid).
     R-2335: TDS a Bills-page payment withheld moves back with its manual line, never undone here.
     R-2601: an advance's TDS (R-1916) is under the same deposited-month lock (month = tds_on). */
  if old.matched_to_type = 'vendor_payment'
     and (new.matched_to_type is distinct from 'vendor_payment' or new.matched_to_id is distinct from old.matched_to_id) then
    for r in select * from public.bank_vendor_payment_lines where bank_txn_id = old.id order by created_at, id loop
      /* R-2335: Bills-page TDS that came here with a matched recorded payment — it goes back with
         the manual line (the recorded_payment row below), it is not undone. */
      if coalesce(r.prev ? 'tds_from_txn', false) then continue; end if;
      -- R-1920: TDS this leg withheld, already paid to the government — undoing would leave
      -- the challan with no deduction behind it.
      if r.tds_amount > 0 and r.kind in ('expense', 'new_expense', 'bill', 'new_bill', 'advance') then
        if r.kind = 'advance' then
          -- R-2601: the advance's TDS was deducted on the bank date (tds_on).
          v_month := coalesce(r.tds_on, old.txn_date);
          v_doc := 'the advance to ' || coalesce((select v.name from public.vendors v where v.id = r.vendor_id), 'the vendor');
        elsif r.kind in ('expense', 'new_expense') then
          select coalesce(x.expense_date, old.txn_date), 'bill ' || coalesce(x.bill_no, x.id) into v_month, v_doc
            from public.expenses x where x.id = r.expense_id;
        else
          select coalesce(r.tds_on, old.txn_date), 'bill ' || coalesce(vb.bill_no, vb.id) into v_month, v_doc
            from public.vendor_bills vb where vb.id = r.vendor_bill_id;
        end if;
        select * into b from public.vendor_tds_deposit_for_month(old.tenant_id, coalesce(v_month, old.txn_date));
        if b.o_msg is not null then
          raise exception 'The ₹% TDS this payment withheld on % is already deposited (%). Undoing it would leave that challan with no TDS behind it. If this payment really was booked wrong, un-reconcile the challan line first (Banking), then this one.',
            r.tds_amount, coalesce(v_doc, '—'), b.o_msg
            using errcode = 'check_violation', hint = b.o_href;
        end if;
      end if;
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
            select '/accounting/banking/' || t.bank_account_id::text into v_href
              from public.bank_transactions t where t.id = v_e.reconciled_txn_id;
            raise exception 'A later bank payment is also on expense bill % — un-reconcile that one first, then this one.',
              coalesce(v_e.bill_no, v_e.id) using errcode = 'check_violation', hint = coalesce(v_href, '/accounting/banking');
          end if;
          -- the rest was settled after this part (Mark paid, or the vendor's advance)
          raise exception 'Expense bill % was settled after this payment (% on %) — mark it unpaid first (Expenses), or undo the advance on it, then un-reconcile.',
            coalesce(v_e.bill_no, v_e.id), coalesce(v_e.payment_method, 'marked paid'), coalesce(to_char(v_e.paid_date, 'DD Mon YYYY'), 'an earlier date')
            using errcode = 'check_violation', hint = '/accounting/expenses';
        end if;
        if r.tds_amount > 0 and exists (select 1 from public.bank_vendor_payment_lines l2
                      where l2.expense_id = r.expense_id and l2.kind = 'expense' and l2.bank_txn_id <> old.id) then
          -- this part withheld the bill's TDS; the other parts were worked out after it
          select '/accounting/banking/' || t.bank_account_id::text into v_href
            from public.bank_vendor_payment_lines l2 join public.bank_transactions t on t.id = l2.bank_txn_id
           where l2.expense_id = r.expense_id and l2.kind = 'expense' and l2.bank_txn_id <> old.id
           order by l2.created_at desc limit 1;
          raise exception 'This payment withheld the TDS on expense bill %, and a later bank payment is also on it — un-reconcile that one first, then this one.',
            coalesce(v_e.bill_no, v_e.id) using errcode = 'check_violation', hint = coalesce(v_href, '/accounting/banking');
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
        -- R-2321: a part-paid new bill whose rest was marked paid (Expenses → Mark paid).
        select * into v_e from public.expenses where id = r.expense_id for update;
        if found and v_e.paid and v_e.reconciled_txn_id is distinct from old.id then
          raise exception 'Expense bill % was settled after this payment (% on %) — mark it unpaid first (Expenses), then un-reconcile.',
            coalesce(v_e.bill_no, v_e.id), coalesce(v_e.payment_method, 'marked paid'), coalesce(to_char(v_e.paid_date, 'DD Mon YYYY'), 'an earlier date')
            using errcode = 'check_violation', hint = '/accounting/expenses';
        end if;
        delete from public.expenses where id = r.expense_id;
      elsif r.kind = 'bank_charge' then
        delete from public.expenses where id = r.expense_id;
      elsif r.kind = 'advance' then
        select consumed_amount into v_used from public.prepaid_advances where id = r.prepaid_advance_id;
        if coalesce(v_used, 0) > 0 then
          -- R-1913: an advance is used either by a Prepaid invoice or by "Apply advance" on a bill.
          -- R-1920: the link goes where it was used (a COGS bill, an expense bill, else Prepaid).
          select case when a.vendor_bill_id is not null then '/accounting/bills' else '/accounting/expenses' end into v_href
            from public.vendor_advance_applications a
           where a.prepaid_advance_id = r.prepaid_advance_id
           order by a.created_at desc limit 1;
          raise exception 'This payment''s advance to the vendor has ₹% already used against bills. Undo it there first (Expenses or Bills → the bill → Undo advance, or delete the invoice on the Prepaid page), then un-reconcile.', v_used
            using errcode = 'check_violation', hint = coalesce(v_href, '/accounting/prepaid');
        end if;
        delete from public.prepaid_advances where id = r.prepaid_advance_id;
      elsif r.kind = 'recorded_payment' then
        -- R-1911: this line had replaced a payment recorded outside the bank. Put it back as it was:
        -- the Bills-page / payment-run manual line returns (paid_amount never moved), a Mark-paid
        -- expense is "paid, waiting for its bank line" again.
        if jsonb_typeof(r.prev->'synthetic') = 'object' then
          insert into public.bank_transactions
          select * from jsonb_populate_record(null::public.bank_transactions, r.prev->'synthetic');
          -- R-2335: the Bills-page TDS row goes back on the manual line it was withheld with.
          update public.bank_vendor_payment_lines
             set bank_txn_id = (r.prev->'synthetic'->>'id')::uuid, prev = null
           where bank_txn_id = old.id and prev->>'tds_from_txn' = r.prev->'synthetic'->>'id';
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
