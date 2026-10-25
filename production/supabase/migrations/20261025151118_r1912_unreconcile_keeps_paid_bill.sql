-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_vendor_payment_line_unmatched()') and prosrc like '%R-1912%')
-- deploy-key: r1912unreconcilekeepspaidbill
-- 20261025151118_r1912_unreconcile_keeps_paid_bill.sql
--
-- R-1912 (25 Oct 2026, p0 — R-1906 audit B7): Undo (un-reconcile) of a bank line that recorded a
-- NEW bill deleted that bill even when other money sat on it.
--
-- ─── THE BUG (proven, Anutech-HQ/drafts/R-1906/r1906_audit_proofs.sql B7) ─────
--   Banking → vendor line ₹5,000 → "The bill is not in the books yet" → new COGS bill ₹11,800, pay
--   ₹5,000. Bills page → Pay the other ₹6,800 (manual bank line matched to the bill). Banking → Undo
--   the first line → tg_vendor_payment_line_unmatched (20261025100013 R-1911, kind 'new_bill')
--   deleted the WHOLE bill: the ₹6,800 line pointed at a deleted bill (money out, no bill, no
--   payable). At commit the R-1577 deferred guard then threw "un-reconcile that bank line first,
--   then delete this bill" — about a delete the owner never asked for — so Undo was impossible;
--   when the other ₹6,800 was an R-1911 matched line it failed on a foreign key instead.
--
-- ─── THE FIX — Undo reverses only what THIS bank line did ─────────────────────
--   new_bill: this line's cash (+ TDS) comes off paid_amount, as for an existing bill. The bill is
--     deleted only when nothing else is on it: no money left on it (paid_amount after this line = 0),
--     no other bank line / vendor-payment row matched to it (matched_bank_line_blocker), no open
--     payment run (vendor_bill_delete_blocker), no purchase-order allocation. Otherwise it STAYS and
--     its status follows the remaining payments (unpaid / partial / paid).
--   new_expense: a new expense bill is paid in full by its own line, so it is still deleted — but if
--     another bank line is matched to it the Undo is refused up front with that line's page as HINT
--     (the R-1577 guard would otherwise fail at commit with a delete-the-expense sentence).
--   Everything else (bill / expense / advance / bank charge / R-1911 recorded_payment) is unchanged.
--   It runs inside the caller's transaction (unreconcile_bank_receipt — one atomic RPC, §17b).
--
-- Started from the LATEST definition: tg_vendor_payment_line_unmatched (20261025100013 R-1911).
-- Stored data is not changed by this migration.
-- Test: supabase/tests/r1912_unreconcile_keeps_paid_bill.test.sql

begin;

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
          raise exception 'This payment''s advance to the vendor has ₹% already used against bills. Delete those bills from the Prepaid page first, then un-reconcile.', v_used
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
