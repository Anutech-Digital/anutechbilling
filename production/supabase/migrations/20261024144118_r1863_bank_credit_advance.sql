-- deploy-peek: to_regprocedure('public.reconcile_bank_credit_as_advance(uuid,uuid)') is not null and to_regprocedure('public.bank_old_one_off_bookings(uuid)') is not null and to_regprocedure('public.relink_bank_one_off_sale(uuid,jsonb)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.unreconcile_bank_receipt(uuid,boolean)') and prosrc like '%R-1863%')
-- deploy-key: r1863bankcreditadvance
-- 20261024144118_r1863_bank_credit_advance.sql
--
-- R-1863 (24 Oct 2026, Pardeep — split from R-1838): money that arrives BEFORE anything is quoted
-- had no path from the bank page, and bank lines booked before R-1838 as one-off "bank sale"
-- invoices could not be moved onto the renewal / add-seats / new quote they really paid.
--
-- ─── WHAT THIS ADDS — the existing money paths, no new credit model ────────────────────────
--   reconcile_bank_credit_as_advance(txn, customer)
--       Books an unmatched money-in line as the customer's ADVANCE (on account). It writes what
--       record_payment writes for an overpayment (20260901110000 / R-1614): a received payment
--       with its receipt voucher (Rule 50, GST advance — GSTR-1 11A reads payments) and a
--       customer_credits row, source 'overpayment', source_payment_id = that payment, status open.
--       payments needs a quote (payments_quote_or_opening_invoice), and record_payment refuses a
--       ₹0 quote, so the payment sits on a ₹0 "Advance on account" holder quote (is_one_off,
--       nothing to invoice — generate_invoice refuses ₹0 too). The balance sheet then reads it
--       exactly like an overpayment: part (1) payment − its overpayment credit = 0, part (3) the
--       open credit = the advance. Record payment's "apply advance credit" (record_desk_payment →
--       redeem_customer_credits) uses it on the next quote, unchanged. Then reconcile_bank_txn.
--   unreconcile_bank_receipt — R-1566 body + one branch: an ADVANCE line is taken back on
--       un-reconcile (delete_payment: receipt voucher kept as cancelled, open credit removed;
--       holder quote rejected). Refused while any of that credit is used or refunded.
--   bank_old_one_off_bookings(account) — bank lines booked BEFORE R-1838 as a one-off bank sale
--       (payment note 'Reconciled from bank receipt'), with what a relink would do and what
--       blocks it. Read only. Nothing is changed automatically (R-1838 decision).
--   relink_bank_one_off_sale(txn, target) — ONE transaction: the old sale is undone through
--       unreconcile_bank_receipt(undo) — an issued GST invoice gets its full credit note (s.34,
--       issue_credit_note_core), a draft one is voided, the receipt is removed — then the line is
--       booked through reconcile_bank_credit_to_item / reconcile_bank_credit_new_sale /
--       reconcile_bank_credit_as_advance. Refused (nothing changed) when the books are locked
--       over the old receipt or invoice.
--
-- Guards: §17c fail-closed tenant check, R-718 money roles (owner / manager / accountant / billing);
-- removing a receipt (un-reconcile an advance, relink) is owner / accountant, as delete_payment.
-- Test: supabase/tests/r1863_bank_credit_advance.test.sql

begin;

-- ── 1. reconcile_bank_credit_as_advance ─────────────────────────────────────
create or replace function public.reconcile_bank_credit_as_advance(p_txn_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller    uuid;
  v_trusted   boolean;
  v_txn       record;
  v_cust      record;
  v_export    boolean;
  v_rate      integer;
  v_qid       text;
  v_ref       text;
  v_voucher   text;
  v_pay_id    uuid;
  v_credit_id uuid;
begin
  /* R-1863 / §17c fail-closed + R-718 money roles. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can be a customer''s advance.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  select c.id, c.name, c.country, c.tenant_id into v_cust from public.customers c where c.id = p_customer_id;
  if not found or v_cust.tenant_id is distinct from v_txn.tenant_id then
    raise exception 'Customer not found in your company — pick the customer who paid.' using errcode = 'no_data_found';
  end if;

  /* The advance's GST rate — same rule as create_direct_invoice / reconcile_bank_credit_new_sale. */
  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case
              when v_export then 0
              when public.supplier_gst_status(v_txn.tenant_id, public.ist_today()) in ('unregistered', 'composition') then 0
              else 18
            end;

  /* The ₹0 holder quote the receipt hangs on (payments need a quote). Nothing to invoice. */
  v_qid := public.next_document_number('quote', v_txn.tenant_id, public.ist_today());
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;
  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, payment_amount, payment_method, payment_reference,
    payment_received_at, is_one_off, billing_cycle, created_date, notes
  ) values (
    v_qid, v_txn.tenant_id, p_customer_id, v_cust.name, 'Advance on account', 0, 0, 0, v_rate, 0,
    '[]'::jsonb, 'accepted', 'received', v_txn.credit, 'bank_transfer',
    coalesce(nullif(btrim(v_txn.reference), ''), 'BANK-' || v_txn.id::text),
    (v_txn.txn_date::timestamp at time zone 'UTC'), true, 'yearly', public.ist_today(),
    'Advance received in the bank on ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
      || ' — kept as customer credit, nothing invoiced yet (R-1863).'
  );

  /* The receipt, as record_payment writes it (voucher from the series, bank date — R-1118). */
  v_ref := coalesce(nullif(btrim(v_txn.reference), ''), 'BANK-' || v_txn.id::text);
  v_voucher := public.next_document_number('receipt_voucher', v_txn.tenant_id, public.ist_today());
  insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
                               status, received_at, receipt_voucher_no, recorded_by, bank_account_id)
  values (v_txn.tenant_id, v_qid, p_customer_id, v_txn.credit, 'bank_transfer', v_ref,
          'Advance on account — bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY'),
          'received', (v_txn.txn_date::timestamp at time zone 'UTC'), v_voucher, auth.uid(), v_txn.bank_account_id)
  returning id into v_pay_id;

  /* The credit, as record_payment writes an overpayment's (same source, same links). */
  insert into public.customer_credits
    (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
  values
    (v_txn.tenant_id, p_customer_id, v_txn.credit, 'overpayment', v_pay_id, v_qid,
     'Advance received ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' (bank) — nothing invoiced yet', 'open')
  returning id into v_credit_id;

  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_pay_id::text, 'manual');

  return jsonb_build_object(
    'kind',               'advance',
    'quote_id',           v_qid,
    'payment_id',         v_pay_id,
    'receipt_voucher_no', v_voucher,
    'credit_id',          v_credit_id,
    'customer_id',        p_customer_id,
    'customer_name',      v_cust.name,
    'amount',             v_txn.credit,
    'advance_credit',     v_txn.credit,
    'tds_amount',         0,
    'outstanding',        0,
    'is_fully_paid',      true,
    'overpaid_credit',    0,
    'subscriptions',      '[]'::jsonb
  );
end;
$$;

revoke all on function public.reconcile_bank_credit_as_advance(uuid, uuid) from public, anon;
grant execute on function public.reconcile_bank_credit_as_advance(uuid, uuid) to authenticated, service_role;

-- A payment that is a bank ADVANCE (R-1863): its note and its ₹0 "Advance on account" holder quote.
create or replace function public.bank_advance_payment(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.payments p
      join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id
     where p.id = p_payment_id
       and (p.tenant_id = public.current_tenant_id() or public.current_tenant_id() is null)
       and p.notes like 'Advance on account — bank credit of %'
       and q.plan = 'Advance on account'
       and coalesce(q.amount, 0) = 0
       and q.invoice_id is null);
$$;

revoke all on function public.bank_advance_payment(uuid) from public, anon;
grant execute on function public.bank_advance_payment(uuid) to authenticated, service_role;

-- ── 2. unreconcile_bank_receipt — R-1566 body + the advance branch (R-1863) ──
CREATE OR REPLACE FUNCTION public.unreconcile_bank_receipt(p_txn_id uuid, p_undo_sale boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_pay     public.payments;
  v_quote   record;
  v_inv     record;
  v_invoice text;
  v_cn      jsonb;
  v_voided  text;
  v_adv     public.payments;
  v_adv_open integer;
  v_adv_bad  integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can un-match a bank line' using errcode = '42501';
  end if;
  /* R-718: "undo the sale" deletes the receipt — a delete, so owner / accountant only. */
  if p_undo_sale and not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a payment' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found then raise exception 'Bank transaction not found' using errcode = 'no_data_found'; end if;
  if v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  /* R-1863: a line booked as a customer's ADVANCE — un-reconciling takes the advance back:
     its receipt and its credit go, so the money is not counted with no bank line behind it. */
  if v_txn.matched_to_type = 'payment' and v_txn.matched_to_id is not null
     and public.bank_advance_payment(v_txn.matched_to_id::uuid) then
    select * into v_adv from public.payments where id = v_txn.matched_to_id::uuid for update;
    if not (coalesce(public.current_request_role(), '') = 'service_role'
            or (public.current_request_role() is null
                and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
       and not public.current_user_has_role('owner', 'accountant') then
      raise exception 'Un-reconciling this line removes the ₹% advance it booked (receipt %). Only an owner or accountant can remove a receipt — ask them to un-reconcile this line.',
        v_adv.amount, coalesce(v_adv.receipt_voucher_no, v_adv.id::text) using errcode = '42501';
    end if;
    perform 1 from public.customer_credits cc
      where cc.tenant_id = v_tenant and cc.source_payment_id = v_adv.id for update;
    select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)::int,
           coalesce(sum(cc.amount) filter (where cc.status <> 'open'), 0)::int
      into v_adv_open, v_adv_bad
      from public.customer_credits cc
     where cc.tenant_id = v_tenant and cc.source_payment_id = v_adv.id;
    if v_adv_bad > 0 or v_adv_open <> v_adv.amount then
      raise exception 'This line''s ₹% advance has ₹% already used or refunded, so it cannot be taken back. Undo that first: on the customer''s Payments, delete or refund the payment that used the credit (the credit opens again), then un-reconcile this line.',
        v_adv.amount, v_adv.amount - v_adv_open using errcode = 'check_violation';
    end if;

    perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');
    perform public.delete_payment(v_adv.id);
    update public.quotes
       set status = 'rejected'::quote_status, payment_status = 'none'::payment_status, payment_amount = 0,
           payment_method = null, payment_reference = null, payment_received_at = null, payment_notes = null
     where id = v_adv.quote_id and tenant_id = v_tenant;

    return jsonb_build_object(
      'unreconciled', true, 'invoice_voided', null, 'invoice_credited', null, 'credit_note_id', null,
      'receipt_removed', v_adv.id, 'advance_removed', v_adv.amount);
  end if;

  if p_undo_sale then
    if v_txn.matched_to_type is distinct from 'payment' or v_txn.matched_to_id is null then
      raise exception 'This line is not reconciled to a customer receipt — nothing to undo.';
    end if;
    select * into v_pay from public.payments where id = v_txn.matched_to_id::uuid for update;
    if not found then raise exception 'The receipt this line points to no longer exists.'; end if;
    if v_pay.notes is distinct from 'Reconciled from bank receipt' then
      raise exception 'This receipt was recorded separately, not from this bank line — undo it from Payments instead.';
    end if;

    select id, invoice_id into v_quote from public.quotes where id = v_pay.quote_id for update;
    v_invoice := v_quote.invoice_id;
    if exists (select 1 from public.payments where quote_id = v_pay.quote_id and id <> v_pay.id) then
      raise exception 'This sale has other receipts too — undo it from the invoice, not from here.';
    end if;
    if v_invoice is not null and (
         exists (select 1 from public.credit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.debit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.tds_receivable where invoice_id = v_invoice)
    ) then
      raise exception 'Invoice % has a credit/debit note or TDS entry — handle it from the invoice.', v_invoice;
    end if;
  end if;

  -- Free the line through the one reconcile path, so every other reversal still runs.
  perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');

  if p_undo_sale then
    if v_invoice is not null then
      select id, status, amount into v_inv from public.invoices where id = v_invoice and tenant_id = v_tenant for update;
      if found then
        if v_inv.status = 'draft' then
          update public.invoices set status = 'void'::invoice_status, paid_date = null
           where id = v_invoice and tenant_id = v_tenant;
          v_voided := v_invoice;
        elsif v_inv.status = 'void' then
          -- R-1566: already cancelled in full — no credit note on a void invoice.
          null;
        else
          -- Issued: reverse with a full credit note; the invoice stays, nothing due.
          -- R-1566: p_settle = false — this sale's money is being taken back (the receipt is
          -- deleted below), so the note must not turn it into customer credit.
          v_cn := public.issue_credit_note_core(v_invoice, v_inv.amount, 'cancellation',
                    'Sale reversed — bank receipt un-reconciled',
                    'unreconcile_bank_receipt ' || p_txn_id::text, false);
          update public.invoices
             set status = 'pending'::invoice_status, paid_date = null, paid_amount = 0, net_payable = 0, updated_at = now()
           where id = v_invoice and tenant_id = v_tenant;
        end if;
      end if;
    end if;
    /* R-1863: the receipt voucher number stays in the record, marked cancelled (CGST 31(3)(d)
       series — never deleted or re-issued), as delete_payment does since R-1568. */
    if v_pay.receipt_voucher_no is not null then
      insert into public.cancelled_vouchers
        (tenant_id, doc_type, doc_no, payment_id, quote_id, customer_id, amount, credit_applied,
         received_at, reason, cancelled_by)
      values
        (v_pay.tenant_id, 'receipt_voucher', v_pay.receipt_voucher_no, v_pay.id, v_pay.quote_id,
         v_pay.customer_id, v_pay.amount, coalesce(v_pay.credit_applied, 0),
         v_pay.received_at, 'Bank sale undone — bank line un-reconciled', public.current_user_id());
    end if;
    delete from public.payments where id = v_pay.id;
    update public.quotes
       set status = 'rejected'::quote_status,
           payment_status = 'none'::payment_status,
           payment_amount = 0,
           payment_method = null, payment_reference = null,
           payment_received_at = null, payment_notes = null
     where id = v_pay.quote_id and tenant_id = v_tenant;
  end if;

  return jsonb_build_object(
    'unreconciled', true,
    'invoice_voided', v_voided,
    'invoice_credited', case when v_cn is not null then v_invoice end,
    'credit_note_id', v_cn->>'credit_note_id',
    'receipt_removed', case when p_undo_sale then v_pay.id end
  );
end;
$function$;

revoke all on function public.unreconcile_bank_receipt(uuid, boolean) from public, anon;
grant execute on function public.unreconcile_bank_receipt(uuid, boolean) to authenticated, service_role;

-- ── 3. bank_old_one_off_bookings ────────────────────────────────────────────
create or replace function public.bank_old_one_off_bookings(p_bank_account_id uuid)
returns table (
  txn_id          uuid,
  txn_date        date,
  amount          integer,
  description     text,
  payment_id      uuid,
  receipt_voucher_no text,
  received_on     date,
  quote_id        text,
  customer_id     uuid,
  customer_name   text,
  product         text,
  invoice_id      text,
  invoice_status  text,
  invoice_date    date,
  invoice_amount  integer,
  blocker         text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_caller  uuid;
  v_trusted boolean;
  v_lock    date;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can see bank receipts' using errcode = '42501';
  end if;
  if v_caller is null then
    select a.tenant_id into v_caller from public.bank_accounts a where a.id = p_bank_account_id;
  end if;
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_caller;

  return query
  select t.id, t.txn_date, t.credit::int, t.description,
         p.id, p.receipt_voucher_no, (p.received_at at time zone 'Asia/Kolkata')::date,
         q.id, q.customer_id, q.customer_name, coalesce(q.plan, q.line_items->0->>'name'),
         i.id, i.status::text, i.invoice_date, coalesce(i.amount, 0)::int,
         case
           when v_lock is not null and (v_lock >= (p.received_at at time zone 'Asia/Kolkata')::date
                                        or (i.id is not null and v_lock >= i.invoice_date))
             then 'books_locked'
           when exists (select 1 from public.payments p2 where p2.quote_id = q.id and p2.id <> p.id)
             then 'other_receipts'
           when i.id is not null and (
                  exists (select 1 from public.credit_notes cn where cn.invoice_id = i.id)
               or exists (select 1 from public.debit_notes dn where dn.invoice_id = i.id)
               or exists (select 1 from public.tds_receivable tr where tr.invoice_id = i.id))
             then 'invoice_notes'
         end
    from public.bank_transactions t
    join public.payments p on p.id::text = t.matched_to_id and p.tenant_id = t.tenant_id
    join public.quotes q on q.id = p.quote_id and q.tenant_id = t.tenant_id
    left join public.invoices i on i.id = q.invoice_id and i.tenant_id = t.tenant_id
   where t.tenant_id = v_caller
     and t.bank_account_id = p_bank_account_id
     and t.matched_to_type = 'payment'
     and p.notes = 'Reconciled from bank receipt'
   order by t.txn_date desc, t.id;
end;
$$;

revoke all on function public.bank_old_one_off_bookings(uuid) from public, anon;
grant execute on function public.bank_old_one_off_bookings(uuid) to authenticated, service_role;

-- ── 4. relink_bank_one_off_sale ─────────────────────────────────────────────
-- p_target: {"path":"item","quote_id"|"invoice_id",…tds/subscription…}
--         | {"path":"new_sale","customer_id","lines",…} | {"path":"advance","customer_id"}
create or replace function public.relink_bank_one_off_sale(p_txn_id uuid, p_target jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid;
  v_trusted boolean;
  v_row     record;
  v_path    text := p_target->>'path';
  v_undo    jsonb;
  v_res     jsonb;
  v_lock    date;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  /* Relink removes the old receipt — a delete, so owner / accountant (delete_payment's rule). */
  if not v_trusted and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Relinking removes the old one-off receipt, so only an owner or accountant can do it. Ask them to press Relink on this line.' using errcode = '42501';
  end if;
  if v_path is null or v_path not in ('item', 'new_sale', 'advance') then
    raise exception 'Pick what this money is for (an open quote / invoice, a new sale or an advance).' using errcode = '22023';
  end if;

  perform 1 from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;

  select o.* into v_row
    from public.bank_transactions t
    cross join lateral public.bank_old_one_off_bookings(t.bank_account_id) o
   where t.id = p_txn_id and o.txn_id = p_txn_id;
  if not found then
    raise exception 'This bank line is not an old one-off bank sale, so there is nothing to relink. Un-reconcile it and reconcile it again instead.' using errcode = 'check_violation';
  end if;
  if v_row.blocker = 'books_locked' then
    select t.books_locked_until into v_lock from public.tenants t where t.id = v_caller;
    raise exception 'Books are locked up to %, and this receipt (%)% falls in a locked month. Nothing was changed. Unlock the books on Accounting → Close month (/accounting/close), relink this line, then lock again.',
      to_char(v_lock, 'DD Mon YYYY'), to_char(v_row.received_on, 'DD Mon YYYY'),
      case when v_row.invoice_id is not null then ' or invoice ' || v_row.invoice_id || ' (' || to_char(v_row.invoice_date, 'DD Mon YYYY') || ')' else '' end
      using errcode = 'check_violation';
  end if;
  if v_row.blocker = 'other_receipts' then
    raise exception 'Quote % has other receipts too, so it cannot be undone from the bank line. Nothing was changed. Open the quote (/quotes/%) and handle its payments there.', v_row.quote_id, v_row.quote_id
      using errcode = 'check_violation';
  end if;
  if v_row.blocker = 'invoice_notes' then
    raise exception 'Invoice % already has a credit / debit note or TDS entry, so it cannot be reversed from here. Nothing was changed. Open the invoice (/invoices/%) and settle it there.', v_row.invoice_id, v_row.invoice_id
      using errcode = 'check_violation';
  end if;

  /* 1. Undo the old one-off sale: credit note (issued GST invoice) / void (draft), receipt removed. */
  v_undo := public.unreconcile_bank_receipt(p_txn_id, true);

  /* 2. Book the line on what the money was really for. */
  if v_path = 'item' then
    v_res := public.reconcile_bank_credit_to_item(
      p_txn_id,
      nullif(p_target->>'quote_id', ''), nullif(p_target->>'invoice_id', ''),
      coalesce((p_target->>'tds_amount')::int, 0), (p_target->>'tds_rate_pct')::numeric, nullif(p_target->>'tds_section', ''),
      (p_target->>'create_subscription')::boolean, (p_target->>'sub_start')::date, (p_target->>'sub_renewal')::date);
  elsif v_path = 'new_sale' then
    v_res := public.reconcile_bank_credit_new_sale(
      p_txn_id, (p_target->>'customer_id')::uuid, coalesce(p_target->'lines', '[]'::jsonb),
      coalesce((p_target->>'create_subscription')::boolean, true), (p_target->>'sub_start')::date, (p_target->>'sub_renewal')::date,
      coalesce((p_target->>'tds_amount')::int, 0), (p_target->>'tds_rate_pct')::numeric, nullif(p_target->>'tds_section', ''));
  else
    v_res := public.reconcile_bank_credit_as_advance(p_txn_id, (p_target->>'customer_id')::uuid);
  end if;

  return v_res || jsonb_build_object(
    'relinked_from_quote',   v_row.quote_id,
    'relinked_from_invoice', v_row.invoice_id,
    'old_invoice_credited',  v_undo->>'invoice_credited',
    'old_invoice_voided',    v_undo->>'invoice_voided',
    'old_credit_note_id',    v_undo->>'credit_note_id');
end;
$$;

revoke all on function public.relink_bank_one_off_sale(uuid, jsonb) from public, anon;
grant execute on function public.relink_bank_one_off_sale(uuid, jsonb) to authenticated, service_role;

commit;
