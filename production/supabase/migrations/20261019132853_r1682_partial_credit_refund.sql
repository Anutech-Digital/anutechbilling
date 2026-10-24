-- deploy-peek: to_regprocedure('public.refund_credit_note_credit(uuid,integer,text)') is not null
-- deploy-key: r1682partialrefund
--
-- R-1682 (P1 money, 19 Oct 2026) — after a cancel + credit note, the credit could not be paid
-- back.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Staging release check, story 19 (T-19): INV-5F40-27-0079 ₹7,646 paid in full, cancelled,
--   credit note CN-5F40-27-0001 ₹6,372 → ₹6,372 open customer credit (R-1566). Payments →
--   Refund only knows refund_payment (20261018171947_r1563_credit_note_refund.sql), which
--   refunds the WHOLE payment: ₹7,646 cash needs ₹7,646 of credit-note cover, so the ₹6,372
--   the company actually owes could never go back. The customer kept "₹6,372 advance credit".
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   refund_credit_note_credit(payment, amount, reason): pays back PART of a payment on an
--   invoiced quote, up to the open credit-note credit on that invoice (never more, never more
--   than the payment's cash). It splits the payment in two inside one transaction —
--     · the original row keeps (amount − refund), its receipt voucher, TDS, credit links, bank
--       account and date;
--     · a new row of the refund amount (same quote, customer, method, date, bank account;
--       reference "<ref> · part refund") is then refunded by refund_payment itself — RFV
--       number, credit-note credit closed ('refunded', split when only part is used),
--       invoice paid_amount / settlement check, quote and subscription recompute.
--   Every report already reads a refunded payment as receipt + refund (customer ledger, day
--   book, balance sheet cash and advances), so the books need no other change: cash falls by
--   the refund, the customer's credit is closed, the invoice stays settled.
--   A refund of the whole cash part is just refund_payment (delegated).
--   Refused: not an invoiced quote, reconciled to a bank line (un-reconcile first, as for a
--   full refund), amount ≤ 0, more than the open credit-note credit or than the payment's cash.
--   Owner / manager / accountant (as refund_payment); tenant fail-closed (§17c).
--
-- Test: supabase/tests/r1682_partial_credit_refund.test.sql

create or replace function public.refund_credit_note_credit(
  p_payment_id uuid,
  p_amount     integer,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1682: refund part of a payment, up to the open credit-note credit on its invoice. */
declare
  v_tenant   uuid := public.current_tenant_id();
  v_trusted  boolean;
  v_pay      record;
  v_inv_id   text;
  v_cash     integer;
  v_cn_open  integer;
  v_max      integer;
  v_new_id   uuid;
  v_r        jsonb;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_trusted then
    raise exception 'No company context — sign in again, then refund.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Refunds are for an owner, manager or accountant. A refund takes a numbered Refund Voucher from your GST series. Ask one of them to record it (Payments → the payment → Refund).'
      using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Refund ki wajah likhiye (kam se kam 5 akshar) — ye voucher par darj hoti hai.'
      using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter the amount to refund (more than ₹0).' using errcode = '22023';
  end if;

  select p.* into v_pay from public.payments p where p.id = p_payment_id for update;
  if not found or (v_tenant is not null and v_pay.tenant_id <> v_tenant) then
    raise exception 'That payment was not found in your company. Refresh Payments and try again.'
      using errcode = '42501';
  end if;
  if v_pay.status <> 'received' then
    raise exception 'Ye payment pehle hi refund ho chuki hai (voucher %).', coalesce(v_pay.refund_voucher_no, '—')
      using errcode = '22023';
  end if;

  select q.invoice_id into v_inv_id
    from public.quotes q where q.id = v_pay.quote_id and q.tenant_id = v_pay.tenant_id;
  if v_inv_id is null then
    raise exception 'This payment''s quote has no GST invoice, so there is no credit note to refund from. Use Refund for the whole payment instead.'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.bank_transactions t
              where t.tenant_id = v_pay.tenant_id and t.matched_to_type = 'payment'
                and t.matched_to_id = v_pay.id::text) then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first (Banking), then refund.'
      using errcode = '22023';
  end if;

  v_cash := v_pay.amount - coalesce(v_pay.credit_applied, 0);
  select coalesce(sum(cc.amount), 0)::int into v_cn_open
    from public.customer_credits cc
   where cc.tenant_id = v_pay.tenant_id and cc.source_invoice_id = v_inv_id
     and cc.source = 'credit_note' and cc.status = 'open';
  v_max := least(v_cash, v_cn_open);
  if v_cn_open <= 0 then
    raise exception 'Invoice % has no open credit from a credit note, so there is nothing to refund. Issue a credit note on it first (Invoices → % → Credit note).', v_inv_id, v_inv_id
      using errcode = '22023';
  end if;
  if p_amount > v_max then
    raise exception 'At most ₹% can be refunded here: ₹% credit-note credit is open on invoice %, and this payment brought ₹% in cash. Lower the amount to ₹% or less.',
      v_max, v_cn_open, v_inv_id, v_cash, v_max
      using errcode = '22023';
  end if;

  /* The whole cash part → the ordinary full refund (same checks, nothing split). */
  if p_amount = v_cash then
    v_r := public.refund_payment(v_pay.id, p_reason);
    return v_r || jsonb_build_object('split', false, 'kept_payment_id', null, 'kept_amount', 0);
  end if;

  /* Split: the original keeps the rest; the refunded part becomes its own row. */
  update public.payments
     set amount = amount - p_amount,
         notes  = left(concat_ws(' · ', nullif(trim(coalesce(notes, '')), ''),
                    format('₹%s of the ₹%s received was refunded (R-1682)', p_amount, v_pay.amount)), 1000)
   where id = v_pay.id;

  insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
                               status, received_at, recorded_by, bank_account_id, credit_applied)
  values (v_pay.tenant_id, v_pay.quote_id, v_pay.customer_id, p_amount, v_pay.method,
          left(coalesce(nullif(trim(v_pay.reference), ''), 'payment') || ' · part refund', 200),
          format('Part of the ₹%s payment%s, split off to refund the credit note on %s',
                 v_pay.amount,
                 case when v_pay.receipt_voucher_no is not null then ' ' || v_pay.receipt_voucher_no else '' end,
                 v_inv_id),
          'received', v_pay.received_at, coalesce(auth.uid(), v_pay.recorded_by), v_pay.bank_account_id, 0)
  returning id into v_new_id;

  v_r := public.refund_payment(v_new_id, p_reason);

  return v_r || jsonb_build_object(
    'split', true,
    'kept_payment_id', v_pay.id,
    'kept_amount', v_pay.amount - p_amount,
    'credit_note_credit_left', v_cn_open - p_amount);
end;
$function$;

comment on function public.refund_credit_note_credit(uuid, integer, text) is
  'R-1682: refund part (or all) of a payment on an invoiced quote, up to the open credit-note credit on that invoice. Splits the payment and refunds the split part through refund_payment (RFV, credit closed, invoice/quote/subscription recompute). Owner/manager/accountant; tenant fail-closed.';

revoke all on function public.refund_credit_note_credit(uuid, integer, text) from public, anon;
grant execute on function public.refund_credit_note_credit(uuid, integer, text) to authenticated, service_role;
