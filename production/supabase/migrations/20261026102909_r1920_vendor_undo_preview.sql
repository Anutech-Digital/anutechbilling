-- deploy-peek: to_regprocedure('public.vendor_payment_undo_preview(uuid)') is not null and to_regprocedure('public.vendor_tds_deposit_for_month(uuid,date)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_vendor_payment_line_unmatched()') and prosrc like '%R-1920%')
-- deploy-key: r1920vendorundopreview
-- 20261026102909_r1920_vendor_undo_preview.sql
--
-- R-1920 (26 Oct 2026, p2, goal G-RECON — R-1906 audit): undo of a vendor-payment bank line
-- from one place, showing first what goes back.
--
-- ─── THE GAP ─────────────────────────────────────────────────────────────────────────────────
--   Banking → a line matched to a vendor (matched_to_type 'vendor_payment') → Un-reconcile showed
--   a generic sentence. The trigger tg_vendor_payment_line_unmatched then silently put bills back
--   to due, took TDS off, deleted a bill / expense the line had created, removed an advance and a
--   bank charge. Refusals (a later part payment, an advance already used) came only after the
--   click, as a toast with no link. And a TDS challan already deposited for that TDS was never
--   checked: undoing the payment took the deduction off the 26Q after the money was paid in.
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────
--   1. vendor_payment_undo_preview(txn) — read-only to the caller. It lists the rows of
--      bank_vendor_payment_lines (what this line paid) with each document's state before and
--      after, and runs the SAME un-match (reconcile_bank_txn → the trigger) inside a savepoint
--      that is always rolled back: the "after" is what the trigger really does, and a refusal
--      comes back as {blocked, block_message, block_href} for the dialog to show with a link.
--      The trigger stays the single writer; the preview only reads.
--   2. tg_vendor_payment_line_unmatched — from its LATEST body (R-1914, 20261026032214) with
--      (a) every refusal carrying a HINT = the page to fix it on, and (b) a new refusal: a leg
--      with TDS (expense / 194Q bill) whose month's TDS challan is already deposited
--      (statutory_dues_payments kind 'tds', period = that month, or no period and paid in the
--      next month — the deposit month). The card's fix asks for this refusal (R-1920 "refuse …
--      when a … deposited TDS challan depends on it").
--   3. vendor_tds_deposit_for_month(tenant, month) — the one place that finds that challan.
--
-- Atomic: unreconcile_bank_receipt is unchanged; it still frees the line through
-- reconcile_bank_txn in the caller's transaction (§17b). Stored data is not changed.
-- Test: supabase/tests/r1920_vendor_undo_preview.test.sql

begin;

-- ── 1. The TDS challan already deposited for a month ─────────────────────────────────────────
create or replace function public.vendor_tds_deposit_for_month(p_tenant uuid, p_month date,
  out o_msg text, out o_href text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s record;
  v_m date := date_trunc('month', p_month)::date;
begin
  /* R-1920: the challan that paid this month's TDS — period = the month the TDS was deducted
     in (R-1583), or no period and paid in the following month (TDS is due by the 7th). */
  if p_tenant is null or p_month is null then return; end if;
  select d.challan_no, d.amount, d.paid_on, d.bank_account_id into s
    from public.statutory_dues_payments d
   where d.tenant_id = p_tenant and d.kind = 'tds'
     and (d.period = to_char(v_m, 'YYYY-MM')
          or (d.period is null and date_trunc('month', d.paid_on)::date = (v_m + interval '1 month')::date))
   order by d.paid_on, d.created_at
   limit 1;
  if not found then return; end if;
  o_msg := format('TDS challan%s of ₹%s paid on %s for %s',
                  coalesce(' ' || s.challan_no, ''), s.amount, to_char(s.paid_on, 'DD Mon YYYY'),
                  to_char(v_m, 'Mon YYYY'));
  o_href := case when s.bank_account_id is not null then '/accounting/banking/' || s.bank_account_id::text
                 else '/accounting/banking' end;
end;
$$;

revoke all on function public.vendor_tds_deposit_for_month(uuid, date) from public, anon, authenticated;
grant execute on function public.vendor_tds_deposit_for_month(uuid, date) to service_role;

-- ── 2. The un-match trigger: links on every refusal + the deposited-TDS refusal ──────────────
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
     leg whose TDS month is already deposited by challan is refused. */
  if old.matched_to_type = 'vendor_payment'
     and (new.matched_to_type is distinct from 'vendor_payment' or new.matched_to_id is distinct from old.matched_to_id) then
    for r in select * from public.bank_vendor_payment_lines where bank_txn_id = old.id order by created_at, id loop
      -- R-1920: TDS this leg withheld, already paid to the government — undoing would leave
      -- the challan with no deduction behind it.
      if r.tds_amount > 0 and r.kind in ('expense', 'new_expense', 'bill', 'new_bill') then
        if r.kind in ('expense', 'new_expense') then
          select coalesce(x.expense_date, old.txn_date), coalesce(x.bill_no, x.id) into v_month, v_doc
            from public.expenses x where x.id = r.expense_id;
        else
          select coalesce(r.tds_on, old.txn_date), coalesce(vb.bill_no, vb.id) into v_month, v_doc
            from public.vendor_bills vb where vb.id = r.vendor_bill_id;
        end if;
        select * into b from public.vendor_tds_deposit_for_month(old.tenant_id, coalesce(v_month, old.txn_date));
        if b.o_msg is not null then
          raise exception 'The ₹% TDS this payment withheld on bill % is already deposited (%). Undoing it would leave that challan with no TDS behind it. If this payment really was booked wrong, un-reconcile the challan line first (Banking), then this one.',
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

-- ── 3. What un-reconciling this vendor line will do — the Undo preview ───────────────────────
create or replace function public.vendor_payment_undo_preview(p_txn_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_tenant  uuid;
  v_txn     public.bank_transactions;
  r         record;
  v_legs    jsonb := '[]'::jsonb;
  v_after   jsonb := '{}'::jsonb;
  v_leg     jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_blocked boolean := false;
  v_msg     text;
  v_hint    text;
  v_vendor  text;
  i         integer;
begin
  /* R-1920: same gate as un-reconciling (R-718 money roles); reads only — the dry run below is
     always rolled back. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_tenant := public.current_tenant_id();
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can un-match a bank line' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found or (v_tenant is not null and v_txn.tenant_id is distinct from v_tenant) then
    raise exception 'Bank transaction not found' using errcode = 'no_data_found';
  end if;
  if v_txn.matched_to_type is distinct from 'vendor_payment' then
    raise exception 'This line is not a vendor payment.' using errcode = '22023';
  end if;

  -- Before: what the line paid, each document as it stands now.
  for r in
    select l.id, l.kind, l.cash, l.tds_amount, l.tds_section, l.vendor_id,
           l.vendor_bill_id, l.expense_id, l.prepaid_advance_id,
           vb.bill_no as vb_no, vb.total as vb_total, vb.paid_amount as vb_paid, vb.status as vb_status,
           x.bill_no as x_no, x.amount as x_total, x.paid_amount as x_paid, x.paid as x_is_paid,
           pa.total_amount as pa_amount
      from public.bank_vendor_payment_lines l
      left join public.vendor_bills vb on vb.id = l.vendor_bill_id
      left join public.expenses x on x.id = l.expense_id
      left join public.prepaid_advances pa on pa.id = l.prepaid_advance_id
     where l.bank_txn_id = p_txn_id
     order by l.created_at, l.id
  loop
    if v_vendor is null and r.vendor_id is not null then
      select name into v_vendor from public.vendors where id = r.vendor_id;
    end if;
    v_legs := v_legs || jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'cash', r.cash, 'tds_amount', r.tds_amount, 'tds_section', r.tds_section,
      'doc_type', case when r.vendor_bill_id is not null then 'vendor_bill'
                       when r.expense_id is not null then 'expense' else 'advance' end,
      'doc_id', coalesce(r.vendor_bill_id, r.expense_id, r.prepaid_advance_id::text),
      'doc_no', coalesce(r.vb_no, r.x_no),
      'doc_total', coalesce(r.vb_total, r.x_total, r.pa_amount),
      'before_paid', coalesce(r.vb_paid, r.x_paid),
      'before_status', case when r.vendor_bill_id is not null then r.vb_status
                            when r.expense_id is not null then
                              case when r.x_is_paid then 'paid' when coalesce(r.x_paid, 0) > 0 then 'partial' else 'unpaid' end
                            else 'open' end,
      'href', case when r.vendor_bill_id is not null then '/accounting/bills'
                   when r.expense_id is not null then '/accounting/expenses' else '/accounting/prepaid' end);
  end loop;

  -- After: run the real un-match (the trigger is the single writer) and always roll it back.
  begin
    perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');
    for i in 0 .. jsonb_array_length(v_legs) - 1 loop
      v_leg := v_legs->i;
      if v_leg->>'doc_type' = 'vendor_bill' then
        select jsonb_build_object('removed', false, 'paid', vb.paid_amount, 'status', vb.status) into v_after
          from public.vendor_bills vb where vb.id = v_leg->>'doc_id';
      elsif v_leg->>'doc_type' = 'expense' then
        select jsonb_build_object('removed', false, 'paid', x.paid_amount,
                 'status', case when x.paid then 'paid' when coalesce(x.paid_amount, 0) > 0 then 'partial' else 'unpaid' end) into v_after
          from public.expenses x where x.id = v_leg->>'doc_id';
      else
        select jsonb_build_object('removed', false, 'paid', null, 'status', 'open') into v_after
          from public.prepaid_advances pa where pa.id = (v_leg->>'doc_id')::uuid;
      end if;
      if not found then v_after := jsonb_build_object('removed', true, 'paid', null, 'status', null); end if;
      v_out := v_out || (v_leg || jsonb_build_object('removed', v_after->'removed', 'after_paid', v_after->'paid',
                                                     'after_status', v_after->'status'));
    end loop;
    raise exception 'R-1920 dry run' using errcode = 'R1920';
  exception
    when sqlstate 'R1920' then
      null;
    when others then
      get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
      v_blocked := true;
      v_out := v_legs;
  end;

  return jsonb_build_object(
    'txn_id', v_txn.id, 'debit', v_txn.debit, 'txn_date', v_txn.txn_date, 'vendor_name', v_vendor,
    'legs', v_out,
    'blocked', v_blocked,
    'block_message', v_msg,
    'block_href', nullif(v_hint, ''));
end;
$$;

revoke all on function public.vendor_payment_undo_preview(uuid) from public, anon;
grant execute on function public.vendor_payment_undo_preview(uuid) to authenticated, service_role;

commit;
