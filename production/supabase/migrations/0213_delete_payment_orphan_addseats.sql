-- 0213 — delete_payment: only block add-seats deletion while a subscription
-- still exists.
--
-- Before: ANY add-seats payment was un-deletable ("adjust from the subscription").
-- But if that subscription was later deleted, the add-seats payment got trapped
-- forever — can't adjust (no subscription), can't delete (guard). This fixes the
-- trap: the add-seats guard now fires ONLY when a live subscription for the same
-- customer still exists (the thing that would desync). Orphaned add-seats payments
-- become deletable by the owner. All other guards (invoice, bank-reconciled,
-- processed PO) are unchanged.

create or replace function public.delete_payment(p_payment_id uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
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

  select id, tenant_id, amount, invoice_id, is_add_seats, lead_id, customer_id, customer_name, status
    into v_quote from public.quotes where id = v_pay.quote_id;

  if v_quote.invoice_id is not null then
    raise exception 'A GST invoice is already generated for this quote — cancel / credit-note that invoice before deleting the payment.'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then delete.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Add-seats payments are tied to a live subscription's seat count — deleting
  -- the payment alone would leave those extra seats unpaid. Block ONLY while such
  -- a subscription still exists. If it's gone (orphaned add-seats), nothing can
  -- desync, so let the owner delete it.
  if coalesce(v_quote.is_add_seats, false) then
    if exists (
      select 1 from public.subscriptions s
       where s.tenant_id = v_pay.tenant_id
         and ( (v_quote.customer_id is not null and s.customer_id = v_quote.customer_id)
            or (v_quote.customer_id is null and s.customer_name = v_quote.customer_name) )
    ) then
      raise exception 'This is an add-seats payment — adjust it from the subscription (reduce seats), not by deleting here.'
        using errcode = 'invalid_parameter_value';
    end if;
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

    if v_quote.lead_id is not null then
      update public.leads set stage = 'quote', trial_converted_at = null
       where id = v_quote.lead_id and tenant_id = v_pay.tenant_id and stage = 'won';
    end if;
  else
    update public.subscriptions set outstanding_amount = greatest(0, v_expected - v_remaining)
     where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
  end if;

  return jsonb_build_object(
    'deleted', true, 'quote_id', v_pay.quote_id, 'amount', v_pay.amount,
    'remaining', v_remaining, 'new_payment_status', v_new_status,
    'subscriptions_removed', v_subs_removed, 'purchase_orders_removed', v_pos_removed
  );
end;
$function$;
