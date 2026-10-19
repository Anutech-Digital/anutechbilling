-- 0127: delete_subscription — remove a manual/imported subscription safely
-- ============================================================================
-- A subscription that came from a PAID quote is entangled with payment + quote
-- + PO, so it must be unwound at the source (delete the payment → 0126). This
-- RPC is for the OTHER case: a manually-added or imported subscription (no
-- received payment behind it) that was entered wrong / by mistake.
--
-- GUARDS (raise → nothing deleted):
--   • a received payment exists for its quote  → delete that payment instead
--   • a linked PO has progressed past 'draft'   → handle it manually
-- Otherwise: drop its draft POs, then the subscription (tasks + renewal-email
-- logs cascade away automatically).

create or replace function public.delete_subscription(p_subscription_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sub    record;
  v_paid_cnt int;
  v_bad_po   int;
  v_pos_removed int := 0;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then raise exception 'Subscription not found'; end if;
  if v_tenant is not null and v_sub.tenant_id is distinct from v_tenant then
    raise exception 'Subscription not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  if v_sub.quote_id is not null then
    select count(*) into v_paid_cnt from public.payments
     where tenant_id = v_sub.tenant_id and quote_id = v_sub.quote_id and status = 'received';
    if v_paid_cnt > 0 then
      raise exception 'This subscription came from a paid quote — delete that payment in Payments instead; it removes this subscription cleanly.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  select count(*) into v_bad_po from public.purchase_orders
   where tenant_id = v_sub.tenant_id and subscription_id = p_subscription_id and status <> 'draft';
  if v_bad_po > 0 then
    raise exception 'A purchase order linked to this subscription is already processed — handle it manually first.'
      using errcode = 'invalid_parameter_value';
  end if;

  delete from public.purchase_orders
   where tenant_id = v_sub.tenant_id and subscription_id = p_subscription_id;
  get diagnostics v_pos_removed = row_count;

  delete from public.subscriptions where id = p_subscription_id;

  return jsonb_build_object('deleted', true, 'purchase_orders_removed', v_pos_removed);
end;
$function$;
