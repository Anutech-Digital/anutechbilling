-- 0126: delete_payment — safely reverse a recorded payment (correct a wrong entry)
-- ============================================================================
-- `record_payment` does a lot (converts lead→customer, creates subscription +
-- PO, updates the quote, may mark an invoice paid). Deleting a payment must
-- reverse the MONEY safely and undo the auto-created service artifacts, while
-- refusing the cases that can't be silently unwound.
--
-- GUARDS (raise → nothing deleted):
--   • a GST invoice is already generated for the quote  → cancel/credit-note first
--   • the payment is reconciled to a bank line          → un-reconcile first
--   • the quote is an add-seats quote                    → manage via subscription
--   • a linked purchase order is past 'draft'            → handle it manually
--
-- REVERSAL:
--   • delete the payment row (the receipt-voucher number is retired, gap is fine)
--   • recompute the quote's payment_amount + payment_status from what's left
--   • if nothing is left  → full undo: delete the subscription(s) + auto POs this
--     quote created, revert the won lead back to 'quote' (the CUSTOMER is kept)
--   • if a balance remains → re-open the subscription's outstanding_amount

create or replace function public.delete_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_pay      record;
  v_quote    record;
  v_remaining integer;
  v_expected  integer;
  v_new_status public.payment_status;
  v_subs_removed int := 0;
  v_pos_removed  int := 0;
  v_bank_cnt int;
  v_bad_po   int;
begin
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if v_tenant is not null and v_pay.tenant_id is distinct from v_tenant then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, lead_id, customer_id, status
    into v_quote from public.quotes where id = v_pay.quote_id;

  -- GUARD 1 — an issued GST tax invoice can't be silently unwound.
  if v_quote.invoice_id is not null then
    raise exception 'A GST invoice is already generated for this quote — cancel / credit-note that invoice before deleting the payment.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- GUARD 2 — reconciled to a bank line.
  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then delete.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- GUARD 3 — add-seats economics belong to the subscription.
  if coalesce(v_quote.is_add_seats, false) then
    raise exception 'This is an add-seats payment — adjust it from the subscription, not by deleting here.'
      using errcode = 'invalid_parameter_value';
  end if;

  delete from public.payments where id = p_payment_id;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);

  v_new_status := case
    when v_remaining <= 0            then 'none'
    when v_remaining >= v_expected   then 'received'
    else                                  'partial' end::public.payment_status;

  update public.quotes
     set payment_status      = v_new_status,
         payment_amount      = v_remaining,
         payment_method      = case when v_remaining <= 0 then null else payment_method end,
         payment_reference   = case when v_remaining <= 0 then null else payment_reference end,
         payment_received_at = case when v_remaining <= 0 then null else payment_received_at end,
         payment_notes       = case when v_remaining <= 0 then null else payment_notes end,
         status              = case when v_remaining <= 0 and status = 'accepted'
                                    then 'sent'::public.quote_status else status end
   where id = v_pay.quote_id and tenant_id = v_pay.tenant_id;

  if v_remaining <= 0 then
    -- Refuse if a PO from this sale has moved past draft (real vendor action).
    select count(*) into v_bad_po
      from public.purchase_orders po
      join public.subscriptions s on s.id = po.subscription_id
     where s.tenant_id = v_pay.tenant_id and s.quote_id = v_pay.quote_id and po.status <> 'draft';
    if v_bad_po > 0 then
      raise exception 'A purchase order from this sale is already processed — handle it manually before deleting the payment.'
        using errcode = 'invalid_parameter_value';
    end if;

    with subs as (
      select id from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id
    )
    delete from public.purchase_orders po using subs where po.subscription_id = subs.id;
    get diagnostics v_pos_removed = row_count;

    delete from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
    get diagnostics v_subs_removed = row_count;

    -- Revert the lead we marked won (keep the customer record intact).
    if v_quote.lead_id is not null then
      update public.leads set stage = 'quote', trial_converted_at = null
       where id = v_quote.lead_id and tenant_id = v_pay.tenant_id and stage = 'won';
    end if;
  else
    update public.subscriptions set outstanding_amount = greatest(0, v_expected - v_remaining)
     where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
  end if;

  return jsonb_build_object(
    'deleted', true,
    'quote_id', v_pay.quote_id,
    'amount', v_pay.amount,
    'remaining', v_remaining,
    'new_payment_status', v_new_status,
    'subscriptions_removed', v_subs_removed,
    'purchase_orders_removed', v_pos_removed
  );
end;
$function$;
