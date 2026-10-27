-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_expense(uuid,text,text,integer,text)') and prosrc like '%R-1917%')
-- deploy-key: r1917bookexpensevendorguard
-- 20261025155521_r1917_book_expense_vendor_guard.sql
--
-- R-1917 (25 Oct 2026, p1 — R-1906 audit B8): "Book as a new expense" on a vendor's bank line while
-- that vendor has an open bill of the same amount booked the cost TWICE.
--
-- ─── THE BUG (proven, Anutech-HQ/drafts/R-1906/r1906_audit_proofs.sql B8) ─────
--   Sharma Associates' ₹11,800 expense bill PS-2 is unpaid. The ₹11,800 Sharma line arrives; on the
--   Reconcile sheet "Book as a new expense" (vendor pre-filled from Category Rules / the narration)
--   was accepted: a NEW paid ₹11,800 expense, PS-2 still open → Sharma cost ₹23,600 for one bill.
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────
--   book_bank_txn_as_expense refuses when the vendor named (any vendor record of this company with
--   that name, case/space-insensitive) has an OPEN ITEM whose money equals the line:
--     · an unpaid expense bill or COGS bill — still due, or still due after the TDS on it;
--     · a payment already recorded outside the bank (Bills page Pay / Expenses Mark paid, R-1911).
--   The open items are bank_debit_vendor_open_items (R-1911, the list the vendor section shows), so
--   the guard and the sheet agree. A bill typed only as a name (no vendor record) is checked by the
--   name. The sentence names the bill and points to "Record payment" (the one way, R-1866).
--   A different amount, a vendor with nothing open, no vendor, or another company's vendor of the
--   same name still book as before.
--
-- Started from the LATEST definition: 20261011120000_r718_money_roles.sql (R-718 role gate kept;
-- auth.role() written as public.current_request_role(), as the newer money functions do). Signature
-- unchanged → grants and comments are kept. Stored data is not changed.
-- Test: supabase/tests/r1917_book_expense_vendor_guard.test.sql (rolled back).

begin;

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
  select * into v_txn from public.bank_transactions
    where id = p_txn_id and tenant_id = v_tenant;
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
   where id = p_txn_id and tenant_id = v_tenant;
  return v_exp_id;
end;
$function$
;

commit;
