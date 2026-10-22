-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.refund_payment(uuid,text)') and prosrc like '%R-1747%')
-- deploy-key: r1747openingrefund
--
-- R-1747 (P1 money, 22 Oct 2026): refunding a payment on an invoice imported from Zoho Books.
--
-- R-1739 lets an imported Zoho invoice (document_kind 'opening_invoice') take payments with
-- payments.quote_id NULL and payments.invoice_id set, and refuses credit / debit notes on it
-- (its GST was filed from Zoho Books). refund_payment looked only at the quote's invoice, so
-- for such a payment it skipped every invoice rule: the refund went through as a plain refund
-- and relied on the R-1739 settle trigger alone to reopen the invoice; the result carried no
-- invoice and a meaningless quote status 'none'.
--
-- THE RULE (one place, here): a payment on an imported invoice is refunded as a PLAIN refund —
--   RFV voucher, payment marked refunded, its TDS receivable reversed (as before), and the
--   invoice's balance opens again by exactly the payment (trg_payments_opening_invoice_settle).
--   No credit note, no customer credit, no GST entry. Refused when the payment's invoice is
--   not an imported invoice of this company, when that invoice is void, and (fail-closed) when
--   the invoice did not reopen by exactly the payment — then nothing is refunded.
--   refund_credit_note_credit already refuses such a payment (no quote → no credit note).
--
-- Body: the LATEST refund_payment (20261018171947_r1563_credit_note_refund.sql — R-1567 + R-1563),
-- unchanged except the blocks marked R-1747. Signature, grants and role rule unchanged.
-- Test: supabase/tests/r1747_opening_invoice_refund.test.sql (rolled back).
-- Rollback: re-run the refund_payment block of 20261018171947_r1563_credit_note_refund.sql.

begin;

CREATE OR REPLACE FUNCTION public.refund_payment(p_payment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant     uuid := public.current_tenant_id();
  v_pay        record;
  v_quote      record;
  v_remaining  integer;
  v_expected   integer;
  v_new_status public.payment_status;
  v_rfv        text;
  v_bank_cnt   integer;
  v_credits    integer := 0;
  v_spent      integer := 0;
  v_spent_on   text;
  v_customer   uuid;
  v_restored   integer := 0;
  v_gap        integer := 0;
  v_row        record;
  v_tds        integer := 0;
  v_inv        record;
  v_inv_id     text;
  v_cash       integer := 0;
  v_own_open   integer := 0;
  v_need       integer := 0;
  v_cn_open    integer := 0;
  v_take       integer := 0;
  v_cn_closed  integer := 0;
  v_was_adv    boolean := false;
  v_adv        integer := 0;
  v_debits     integer := 0;
  v_credits_cn integer := 0;
  v_due        integer := 0;
  v_settled    integer := 0;
  v_open       record;              -- R-1747: the imported Zoho invoice of a quote-less payment
  v_open_after record;
begin
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Refund ki wajah likhiye (kam se kam 5 akshar) — ye voucher par darj hoti hai.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_pay.tenant_id is distinct from v_tenant) then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  /* R-042: owner / manager / accountant only (see 20260930176000). A session with no JWT
     (psql, a migration, the SQL tests) is left alone, as the tenant check above does. */
  if coalesce(auth.role(), '') in ('anon', 'authenticated')
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception
      'Refunds are for an owner, manager or accountant. A refund takes a numbered Refund Voucher from your GST series and reopens the balance on that customer, so it is not a staff-level action. Ask one of them to record it (Payments → the payment → Refund).'
      using errcode = 'insufficient_privilege';
  end if;
  if v_pay.status = 'refunded' then
    raise exception 'Ye payment pehle hi refund ho chuki hai (voucher %).', coalesce(v_pay.refund_voucher_no, '—')
      using errcode = 'invalid_parameter_value';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, customer_id, customer_name
    into v_quote from public.quotes where id = v_pay.quote_id;

  /* ── R-1747: a payment on an invoice imported from Zoho Books (R-1739) ──────────────
     No quote; payments.invoice_id names the imported invoice. It cannot take a credit note
     here (its GST was filed in Zoho Books), so the refund is a plain one: the invoice's
     balance opens again by this payment (checked after the update below, fail-closed). */
  if v_pay.quote_id is null then
    select i.id, i.status, i.document_kind, i.paid_amount, i.amount, i.net_payable,
           coalesce(nullif(btrim(i.external_number), ''), i.id) as number
      into v_open
      from public.invoices i
     where i.id = v_pay.invoice_id and i.tenant_id = v_pay.tenant_id
     for update;
    if v_pay.invoice_id is null or not found or v_open.document_kind is distinct from 'opening_invoice' then
      raise exception 'This payment is not on a quote or on an invoice imported from Zoho Books in your company, so it cannot be refunded here. Refresh Payments; if it still shows, tell support.'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_open.status::text = 'void' then
      raise exception 'Invoice % is void, so refunding this payment would not reopen any balance. Refund refused.', v_open.number
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  /* ── R-1563: a payment on an invoiced quote ─────────────────────────────────────────
     The invoice is a GST tax invoice: cash goes back only against a CREDIT NOTE (CGST s.34),
     never straight. issue_credit_note (R-1566) turns the part of a note that goes past what
     was still owed into open customer credit (source_invoice_id = this invoice). The refund
     is allowed when that open credit — plus this payment's own open overpayment credit,
     closed below as before — covers the cash going back; those rows are paid out. */
  if v_quote.invoice_id is not null then
    select i.id, i.amount, i.status, i.paid_amount, i.net_payable, i.adjusted_advances
      into v_inv
      from public.invoices i where i.id = v_quote.invoice_id and i.tenant_id = v_pay.tenant_id for update;
    if not found then
      raise exception 'Quote % points at invoice %, which is not in your company — refund refused.', v_pay.quote_id, v_quote.invoice_id
        using errcode = 'invalid_parameter_value';
    end if;
    v_inv_id := v_inv.id;
    v_cash := v_pay.amount - coalesce(v_pay.credit_applied, 0);
    select coalesce(sum(amount), 0)::int into v_own_open
      from public.customer_credits
     where tenant_id = v_pay.tenant_id and source_payment_id = v_pay.id and status = 'open';
    v_need := greatest(0, v_cash - v_own_open);
    select coalesce(sum(amount), 0)::int into v_cn_open
      from public.customer_credits
     where tenant_id = v_pay.tenant_id and source_invoice_id = v_inv_id
       and source = 'credit_note' and status = 'open';
    if v_need > v_cn_open then
      raise exception 'Is quote par GST invoice % jaari hai — tax invoice ke against paisa seedha wapas nahi hota, pehle CREDIT NOTE chahiye. Is refund ke liye ₹% credit note se cover hona chahiye; abhi invoice % ke credit note(s) se ₹% credit khula hai. Invoices → % → Issue credit note se ₹% ka credit note banaiye, phir yahin Refund dabaiye.',
        v_inv_id, v_need, v_inv_id, v_cn_open, v_inv_id, v_need - v_cn_open
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then refund.'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(v_quote.is_add_seats, false) then
    if exists (
      select 1 from public.subscriptions s
       where s.tenant_id = v_pay.tenant_id
         and ( (v_quote.customer_id is not null and s.customer_id = v_quote.customer_id)
            or (v_quote.customer_id is null and s.customer_name = v_quote.customer_name) )
    ) then
      raise exception 'Ye add-seats ki payment hai — pehle subscription par seats ghataiye, phir refund; warna seats mile hue aur paisa wapas dono ho jate.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  /* ── R-1567: advance credit this payment CREATED that is already spent ─────────────
     A full refund would pay that money out a second time (it already settled another
     quote). Refund / delete the payment that used it first — that gives the credit back. */
  select coalesce(sum(cc.amount), 0)::int,
         string_agg(distinct coalesce(p.quote_id, 'kisi purani payment'), ', ')
    into v_spent, v_spent_on
    from public.customer_credits cc
    left join public.payments p on p.id = cc.applied_payment_id and p.tenant_id = cc.tenant_id
   where cc.tenant_id = v_pay.tenant_id and cc.source_payment_id = v_pay.id and cc.status = 'used';
  if v_spent > 0 then
    raise exception 'Ye refund nahi ho sakta: is payment se bana ₹% advance credit pehle hi quote % ki payment me lag chuka hai — poora refund karne se ye ₹% customer ko do baar milega. Pehle Payments me quote % wali payment ko refund ya delete kariye (credit wapas khul jayega), phir ye refund kariye.',
      v_spent, v_spent_on, v_spent, v_spent_on
      using errcode = 'invalid_parameter_value';
  end if;

  v_rfv := public.next_document_number('refund_voucher', v_pay.tenant_id);

  update public.payments
     set status = 'refunded',
         refunded_at = now(),
         refund_reason = trim(p_reason),
         refund_voucher_no = v_rfv
   where id = p_payment_id;

  /* Isi payment ki tairti overpayment-credit band — paisa wapas ja raha hai,
     credit ke roop me dobara kharch nahi ho sakta. */
  update public.customer_credits
     set status = 'refunded'
   where source_payment_id = p_payment_id and status = 'open' and tenant_id = v_pay.tenant_id;
  get diagnostics v_credits = row_count;

  /* ── R-1567: credit this payment APPLIED goes back to the customer ────────────────
     Only the cash part (amount − credit_applied) is refunded; the credit was never cash
     on this payment. Linked rows re-open; an older payment (before applied_payment_id)
     re-opens that customer's unlinked used rows that fit, then a new row for the rest. */
  if coalesce(v_pay.credit_applied, 0) > 0 then
    with r as (
      update public.customer_credits
         set status = 'open', applied_payment_id = null, used_at = null
       where tenant_id = v_pay.tenant_id and applied_payment_id = v_pay.id and status = 'used'
      returning amount)
    select coalesce(sum(amount), 0)::int into v_restored from r;

    v_gap := v_pay.credit_applied - v_restored;
    if v_gap > 0 then
      v_customer := coalesce(v_pay.customer_id, v_quote.customer_id);
      if v_customer is null then
        raise exception 'Is payment me ₹% advance credit laga tha, par payment par customer nahi hai — credit kise wapas jaye ye tay nahi. Pehle quote % par customer jodiye, phir refund kariye.',
          v_gap, v_pay.quote_id using errcode = 'invalid_parameter_value';
      end if;
      for v_row in
        select id, amount from public.customer_credits
         where tenant_id = v_pay.tenant_id and customer_id = v_customer
           and status = 'used' and applied_payment_id is null and used_at is null
         order by created_at desc
         for update
      loop
        exit when v_gap <= 0;
        if v_row.amount <= v_gap then
          update public.customer_credits set status = 'open' where id = v_row.id;
          v_gap := v_gap - v_row.amount;
          v_restored := v_restored + v_row.amount;
        end if;
      end loop;
      if v_gap > 0 then
        insert into public.customer_credits (tenant_id, customer_id, amount, source, source_quote_id, note, status)
        values (v_pay.tenant_id, v_customer, v_gap, 'restored', v_pay.quote_id,
                'Credit given back — payment on ' || v_pay.quote_id || ' refunded (' || v_rfv || ')', 'open');
        v_restored := v_restored + v_gap;
      end if;
    end if;
    if v_restored <> v_pay.credit_applied then
      raise exception 'R-1567: gave back ₹% of ₹% credit applied on payment % — nothing was refunded.', v_restored, v_pay.credit_applied, v_pay.id;
    end if;
  end if;

  /* ── R-1567: the TDS on a refunded payment is no longer receivable ────────────────
     Rows still on the books are reversed; claimed / written-off rows are already off them. */
  update public.tds_receivable
     set status = 'reversed',
         notes  = concat_ws(' · ', nullif(trim(coalesce(notes, '')), ''), 'Reversed: payment refunded (' || v_rfv || ')')
   where tenant_id = v_pay.tenant_id and payment_id = v_pay.id
     and status in ('pending_cert', 'cert_received', 'verified_26as', 'disputed');
  get diagnostics v_tds = row_count;

  /* ── R-1563: the credit-note credit this refund pays out is closed ─────────────────
     (oldest first; a row used only in part is split — the paid-out part kept as a
     'refunded' row with the same note / invoice, so the credit stays traceable). */
  if v_inv_id is not null and v_need > 0 then
    v_take := v_need;
    for v_row in
      select id, amount, customer_id, source_quote_id, source_credit_note_id
        from public.customer_credits
       where tenant_id = v_pay.tenant_id and source_invoice_id = v_inv_id
         and source = 'credit_note' and status = 'open'
       order by created_at asc, id
       for update
    loop
      exit when v_take <= 0;
      if v_row.amount <= v_take then
        update public.customer_credits set status = 'refunded' where id = v_row.id;
        v_take := v_take - v_row.amount;
        v_cn_closed := v_cn_closed + v_row.amount;
      else
        update public.customer_credits set amount = amount - v_take where id = v_row.id;
        insert into public.customer_credits
          (tenant_id, customer_id, amount, source, source_quote_id, source_credit_note_id, source_invoice_id, note, status)
        values
          (v_pay.tenant_id, v_row.customer_id, v_take, 'credit_note', v_row.source_quote_id, v_row.source_credit_note_id, v_inv_id,
           'Paid out as cash — refund ' || v_rfv || ' of the payment on ' || v_pay.quote_id, 'refunded');
        v_cn_closed := v_cn_closed + v_take;
        v_take := 0;
      end if;
    end loop;
    if v_cn_closed <> v_need then
      raise exception 'R-1563: closed ₹% of ₹% credit-note credit on invoice % — nothing was refunded.', v_cn_closed, v_need, v_inv_id;
    end if;
  end if;

  /* ── R-1563: the invoice's settlement after the refund ─────────────────────────────
     paid_amount (money after the invoice) drops by this payment unless it was an advance the
     invoice adjusted (that one drops out because the payment is now refunded). The invoice
     must still be covered — fail closed otherwise (credit notes keep `due` ≤ `settled`). */
  if v_inv_id is not null then
    v_was_adv := exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(v_inv.adjusted_advances) = 'array'
                                              then v_inv.adjusted_advances else '[]'::jsonb end) adv
       where adv->>'payment_id' = v_pay.id::text);
    if not v_was_adv then
      update public.invoices
         set paid_amount = greatest(0, coalesce(paid_amount, 0) - v_pay.amount), updated_at = now()
       where id = v_inv_id;
    end if;

    select coalesce(sum((adv->>'amount')::int), 0)::int into v_adv
      from public.invoices i,
           jsonb_array_elements(case when jsonb_typeof(i.adjusted_advances) = 'array'
                                     then i.adjusted_advances else '[]'::jsonb end) adv
     where i.id = v_inv_id
       and not exists (select 1 from public.payments p
                        where p.id::text = adv->>'payment_id' and p.status = 'refunded');
    select coalesce(sum(amount), 0)::int into v_debits from public.debit_notes where invoice_id = v_inv_id;
    select coalesce(sum(amount), 0)::int into v_credits_cn from public.credit_notes where invoice_id = v_inv_id;
    v_due := greatest(0, coalesce(v_inv.amount, 0) + v_debits - v_credits_cn);
    select coalesce(paid_amount, 0) + v_adv into v_settled from public.invoices where id = v_inv_id;
    if v_inv.status = 'paid' and v_was_adv is false and coalesce(v_inv.paid_amount, 0) < v_pay.amount then
      /* An older invoice marked paid without paid_amount: its settlement is not on the row;
         the credit-note cover above is what keeps it whole. */
      v_settled := greatest(v_settled, v_due);
    end if;
    if v_settled < v_due then
      raise exception 'Ye refund invoice % ko ₹% baaki chhod deta — pehle us invoice par itne ka credit note banaiye, phir refund.', v_inv_id, v_due - v_settled
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  /* ── R-1747: the imported invoice reopened by exactly this payment — else refuse ─── */
  if v_pay.quote_id is null then
    select i.paid_amount, i.amount, i.net_payable, i.status into v_open_after
      from public.invoices i where i.id = v_open.id;
    if coalesce(v_open_after.paid_amount, 0) <> coalesce(v_open.paid_amount, 0) - v_pay.amount then
      raise exception 'R-1747: invoice % paid amount went from ₹% to ₹% on refunding ₹% — nothing was refunded.',
        v_open.number, coalesce(v_open.paid_amount, 0), coalesce(v_open_after.paid_amount, 0), v_pay.amount;
    end if;
    return jsonb_build_object(
      'refund_voucher_no', v_rfv,
      'payment_id', p_payment_id,
      'amount', v_pay.amount - coalesce(v_pay.credit_applied, 0),
      'settled_amount', v_pay.amount,
      'credit_restored', v_restored,
      'tds_reversed', v_tds,
      'quote_id', null,
      'new_payment_status', null,
      'credits_closed', v_credits,
      'invoice_id', v_open.id,
      'invoice_number', v_open.number,
      'opening_invoice', true,
      'invoice_due_after', greatest(0, coalesce(v_open_after.net_payable, v_open_after.amount) - coalesce(v_open_after.paid_amount, 0)),
      'credit_note_credit_paid_out', 0,
      'gateway_refunded', false
    );
  end if;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);
  v_new_status := case
    when v_inv_id is not null       then 'invoiced'   -- R-1563: the invoice stands; the note settled it
    when v_remaining <= 0          then 'none'
    when v_remaining >= v_expected then 'received'
    else                                'partial' end::public.payment_status;

  update public.quotes
     set payment_status = v_new_status,
         payment_amount = v_remaining
   where id = v_pay.quote_id;

  update public.subscriptions
     set outstanding_amount = case when v_inv_id is not null
                                   then greatest(0, v_due - v_settled)       -- R-1563: what the invoice still owes
                                   else greatest(0, v_expected - v_remaining) end
   where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;

  return jsonb_build_object(
    'refund_voucher_no', v_rfv,
    'payment_id', p_payment_id,
    'amount', v_pay.amount - coalesce(v_pay.credit_applied, 0),
    'settled_amount', v_pay.amount,
    'credit_restored', v_restored,
    'tds_reversed', v_tds,
    'quote_id', v_pay.quote_id,
    'new_payment_status', v_new_status,
    'credits_closed', v_credits,
    'invoice_id', v_inv_id,
    'credit_note_credit_paid_out', v_cn_closed,
    'gateway_refunded', false
  );
end $function$;

comment on function public.refund_payment(uuid, text) is
  'Refund a payment in one transaction: RFV number, quote/subscription recompute, its open overpayment credit closed. R-1567: refused while credit it created is spent elsewhere; credit it applied is given back (RFV = cash part); its TDS receivable is reversed. R-1563: on an invoiced quote only the cash covered by credit-note credit on that invoice (that credit is paid out). R-1747: a payment on an imported Zoho invoice is a plain refund — the invoice reopens by exactly the payment (fail-closed), no credit note. Owner/manager/accountant.';

revoke all on function public.refund_payment(uuid, text) from public, anon;
grant execute on function public.refund_payment(uuid, text) to authenticated, service_role;

commit;
