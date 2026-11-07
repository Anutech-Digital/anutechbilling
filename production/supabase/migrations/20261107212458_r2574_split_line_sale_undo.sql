-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public._bank_sale_undo_scope(uuid)') and prosrc like '%R-2574%')
-- deploy-key: r2574splitlinesaleundo
--
-- R-2574 (7 Nov 2026, p1 money — independent review of R-2179).
--
-- ─── WHAT THIS CHANGES ──────────────────────────────────────────────────────────────────────────
--   _bank_sale_undo_scope  ← 20261107192231_r2179_reconcile_gaps (its only body). Same signature and grants.
--   reconcile_bank_credit_split (R-2518) books every new sale / item / advance of ONE bank line as its own
--   receipt (payments.bank_txn_id = the line) and points the line at the FIRST receipt only. R-2179's scope
--   looked only at that first receipt, so "Undo this sale too" took back sale A and left sale B (or the
--   advance kept from the same money) as receipts on NO bank line — receipts more than the bank money, and
--   the owner told the line's sale was undone.
--   Now: when the line booked any other receipt, the undo is refused (nothing changes) and the preview names
--   each one (other_receipts: kind sale / advance / payment, amount, voucher, quote, invoice, page). The way
--   on: un-reconcile WITHOUT the undo, then take back each one on its own page. Both bank_sale_undo_preview
--   and unreconcile_bank_receipt read this scope (the undo re-reads it under the locks), so neither needs a
--   new body.
--   Not done (Pardeep can ask): undo every sale / advance of the line together — more money paths in one
--   step; the block is the safer first step.
-- Test: supabase/tests/r2574_split_line_sale_undo.test.sql (begin … rollback; red without this file).
-- Rollback: re-run the _bank_sale_undo_scope body from 20261107192231_r2179_reconcile_gaps.sql.

create or replace function public._bank_sale_undo_scope(p_txn_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2574: a line that also booked other receipts (a split line — several sales, a sale + advance, a sale + an
   invoice paid) is refused: "Undo this sale" takes back one sale only. other_receipts lists them all. */
declare
  v_txn    record;
  v_pay    record;
  v_q      record;
  v_subs   jsonb;
  v_tds    integer;
  v_bad    record;
  v_block  text := null;
  v_href   text := null;
  v_others jsonb := '[]'::jsonb;   -- R-2574
  v_otext  text;                   -- R-2574
begin
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found or v_txn.matched_to_type is distinct from 'payment' or v_txn.matched_to_id is null then
    return jsonb_build_object('is_new_sale', false);
  end if;
  /* The receipt this line booked — its reference is the line's (bank_line_payment_reference): a receipt
     recorded elsewhere and matched to this line later is not "booked from this line". */
  select p.* into v_pay from public.payments p
   where p.id::text = v_txn.matched_to_id and p.tenant_id = v_txn.tenant_id;
  if not found or v_pay.quote_id is null
     or v_pay.reference is distinct from public.bank_line_payment_reference(v_txn.reference, v_txn.id) then
    return jsonb_build_object('is_new_sale', false);
  end if;
  select q.id, q.invoice_id, q.status, q.amount, q.customer_id, q.customer_name, q.invoice_on_receipt into v_q
    from public.quotes q where q.id = v_pay.quote_id and q.tenant_id = v_txn.tenant_id;
  if not found or not coalesce(v_q.invoice_on_receipt, false) then
    return jsonb_build_object('is_new_sale', false);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'plan', s.plan, 'domain', s.domain, 'seats', s.seats, 'status', s.status,
           'renewal_date', s.renewal_date, 'billing_cycle', s.billing_cycle) order by s.created_at, s.id), '[]'::jsonb)
    into v_subs
    from public.subscriptions s where s.tenant_id = v_txn.tenant_id and s.quote_id = v_q.id;
  select coalesce(sum(t.tds_amount), 0)::int into v_tds
    from public.tds_receivable t where t.tenant_id = v_txn.tenant_id and t.payment_id = v_pay.id;

  /* R-2574: every OTHER receipt this line booked (reconcile_bank_credit_split sets bank_txn_id on each). */
  select coalesce(jsonb_agg(jsonb_build_object(
           'payment_id', o.id, 'kind', o.kind, 'amount', o.amount, 'receipt_voucher_no', o.receipt_voucher_no,
           'quote_id', o.quote_id, 'invoice_id', o.inv,
           'href', case when o.kind = 'advance' then '/payments'
                        when o.inv is not null then '/invoices/' || o.inv
                        when o.quote_id is not null then '/quotes/' || o.quote_id
                        else '/payments' end)
           order by o.ord, o.id), '[]'::jsonb),
         string_agg(case o.kind
                      when 'advance' then 'an advance of ₹' || to_char(o.amount, 'FM99,99,99,999')
                      when 'sale' then 'sale ' || o.quote_id || ' ₹' || to_char(o.amount, 'FM99,99,99,999')
                      else 'a payment on ' || coalesce(o.inv, o.quote_id, 'another document') || ' ₹' || to_char(o.amount, 'FM99,99,99,999')
                    end, ', ' order by o.ord, o.id)
    into v_others, v_otext
    from (
      select p2.id, p2.amount, p2.receipt_voucher_no, p2.quote_id, k.kind, coalesce(q2.invoice_id, p2.invoice_id) as inv,
             case k.kind when 'sale' then 0 when 'payment' then 1 else 2 end as ord
        from public.payments p2
        left join public.quotes q2 on q2.id = p2.quote_id and q2.tenant_id = p2.tenant_id
        cross join lateral (select case when public.bank_advance_payment(p2.id) then 'advance'
                                        when coalesce(q2.invoice_on_receipt, false) then 'sale'
                                        else 'payment' end as kind) k
       where p2.tenant_id = v_txn.tenant_id and p2.bank_txn_id = v_txn.id and p2.id <> v_pay.id
    ) o;

  /* What stops the undo — each with the page to fix it on. */
  if jsonb_array_length(v_others) > 0 then
    v_block := 'This bank line also booked ' || v_otext || ' — "Undo this sale" takes back one sale only. '
               || 'Un-reconcile without it (the receipts stay, on no bank line), then take back each one on its own page.';
    v_href  := v_others->0->>'href';
  end if;
  if v_block is null and exists (select 1 from public.payments p2
              where p2.tenant_id = v_txn.tenant_id and p2.quote_id = v_q.id and p2.id <> v_pay.id) then
    v_block := 'This sale has other receipts too, so it cannot be undone from this bank line. Open quote ' || v_q.id || ' and handle its payments there.';
    v_href  := '/quotes/' || v_q.id;
  end if;
  if v_block is null and v_q.invoice_id is not null and (
       exists (select 1 from public.credit_notes cn where cn.invoice_id = v_q.invoice_id)
    or exists (select 1 from public.debit_notes dn where dn.invoice_id = v_q.invoice_id)) then
    v_block := 'Invoice ' || v_q.invoice_id || ' already has a credit or debit note, so the sale cannot be undone from here. Open the invoice and settle it there.';
    v_href  := '/invoices/' || v_q.invoice_id;
  end if;
  if v_block is null then
    /* A TDS row of another receipt on this invoice, or one the customer already reported. */
    select t.id, t.status, t.tds_amount into v_bad
      from public.tds_receivable t
     where t.tenant_id = v_txn.tenant_id
       and ((v_q.invoice_id is not null and t.invoice_id = v_q.invoice_id) or t.payment_id = v_pay.id)
       and (t.payment_id is distinct from v_pay.id or t.status is distinct from 'pending_cert')
     order by t.id limit 1;
    if found then
      v_block := 'The ₹' || v_bad.tds_amount || ' TDS on this sale (' || v_bad.id || ') is marked "' || replace(coalesce(v_bad.status, ''), '_', ' ')
                 || '" — check it on TDS receivable (with your CA) before undoing the sale.';
      v_href  := '/accounting/tds-receivable';
    end if;
  end if;
  if v_block is null then
    /* A subscription of this sale already billed something else (a later part / term) on its own invoice. */
    select b.invoice_id, s.plan into v_bad
      from public.subscription_billings b
      join public.subscriptions s on s.id = b.subscription_id
     where s.tenant_id = v_txn.tenant_id and s.quote_id = v_q.id
       and b.invoice_id is not null and b.invoice_id is distinct from v_q.invoice_id
     order by b.bill_on, b.id limit 1;
    if found then
      v_block := 'The ' || coalesce(v_bad.plan, 'subscription') || ' made by this sale already billed invoice ' || v_bad.invoice_id
                 || ', so the sale cannot be undone from here. Settle that invoice first (credit note), then un-reconcile this line.';
      v_href  := '/invoices/' || v_bad.invoice_id;
    end if;
  end if;
  if v_block is null then
    /* Money beyond the sale kept as the customer's credit (record_payment's overpayment) already used. */
    select cc.amount into v_bad
      from public.customer_credits cc
     where cc.tenant_id = v_txn.tenant_id and cc.source_payment_id = v_pay.id and cc.status is distinct from 'open'
     limit 1;
    if found then
      v_block := 'The extra money on this receipt was kept as the customer''s credit and is already used or refunded. Undo that first on the customer''s Payments, then un-reconcile this line.';
      v_href  := '/payments';
    end if;
  end if;
  if v_block is null then
    /* A vendor order for one of its subscriptions already placed (a draft one is cancelled with it). */
    select po.id, po.status into v_bad
      from public.purchase_orders po
      join public.subscriptions s on s.id = po.subscription_id
     where s.tenant_id = v_txn.tenant_id and s.quote_id = v_q.id and po.status not in ('draft', 'cancelled')
     limit 1;
    if found then
      v_block := 'The vendor order for this sale is already ' || v_bad.status || ', so the sale cannot be undone from here. Cancel it with the vendor (Purchase orders) first, then un-reconcile this line.';
      v_href  := '/purchase-orders';
    end if;
  end if;
  if v_block is null then
    /* A later quote on one of its subscriptions (renewal, add seats, a part request) that is not cancelled. */
    select q2.id into v_bad
      from public.quotes q2
      join public.subscriptions s on s.tenant_id = q2.tenant_id and s.quote_id = v_q.id
     where q2.tenant_id = v_txn.tenant_id and q2.id <> v_q.id
       and q2.status::text not in ('rejected', 'expired')
       and (q2.renewal_subscription_id = s.id or q2.add_seats_subscription_id = s.id or s.renewal_quote_id = q2.id
            or q2.subscription_billing_id in (select b.id from public.subscription_billings b where b.subscription_id = s.id))
     order by q2.id limit 1;
    if found then
      v_block := 'Quote ' || v_bad.id || ' was made later on a subscription of this sale. Cancel (reject) that quote first, then un-reconcile this line.';
      v_href  := '/quotes/' || v_bad.id;
    end if;
  end if;

  return jsonb_build_object(
    'is_new_sale', true,
    'payment_id', v_pay.id, 'receipt_voucher_no', v_pay.receipt_voucher_no, 'amount', v_pay.amount,
    'quote_id', v_q.id, 'invoice_id', v_q.invoice_id,
    'customer_id', v_q.customer_id, 'customer_name', v_q.customer_name,
    'subscriptions', v_subs, 'tds_amount', v_tds,
    'other_receipts', v_others,                                       -- R-2574
    'blocked', v_block is not null, 'block_message', v_block, 'block_href', v_href);
end;
$$;
revoke all on function public._bank_sale_undo_scope(uuid) from public, anon, authenticated;
grant execute on function public._bank_sale_undo_scope(uuid) to service_role;
