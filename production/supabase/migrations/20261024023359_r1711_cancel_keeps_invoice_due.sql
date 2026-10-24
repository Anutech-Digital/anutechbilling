-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.cancel_subscription(uuid,date,text,boolean)') and prosrc like '%R-1711%')
-- deploy-key: r1711cancelinvoicedue
-- 20261024023359_r1711_cancel_keeps_invoice_due.sql
--
-- R-1711 (billing audit, T-A1): cancel_subscription(…, p_clear_due => true)
-- (20261009151000_cancel_subscription.sql:96-108) set outstanding_amount = 0 while the
-- subscription's GST invoice INV-0013 stayed `pending` for ₹18,232. The subscription said
-- "nothing owed", the invoice, Payment Follow-up, dunning and GSTR-1 said ₹18,232 — and the
-- cancel dialog offered no way to raise the credit note that actually reduces it.
--
-- RULE (accounting, recorded on the card): an issued tax invoice is only reduced by a credit
-- note on it (CGST s.34) — never by editing a balance somewhere else. So:
--   · "Clear the due" closes only the part of outstanding_amount that NO open invoice of this
--     subscription asks for (own quote, renewal quote, its instalments — the same match as
--     write_off_subscription, 20261023184545). Open = pending/overdue, not written off,
--     net_payable − paid_amount > 0.
--   · When every rupee of the due is still on an open invoice, the clear is REFUSED, naming
--     the invoice(s) and the credit note. The cancel without clearing is still allowed (the
--     customer may really still owe it).
--   · When part is on an open invoice, only the rest is cleared; the result carries
--     due_kept + open_invoices so the screen says what is still owed and where.
--   · After a credit note brings the invoice to 0, the clear closes the whole due — the
--     subscription and the invoice agree.
--
-- Not changed: signature, grants, who may cancel, the date rules, any stored row. Subscriptions
-- already cancelled with a cleared due while an invoice stayed open are left as they are —
-- listed as needsDecision on card R-1711.
-- Test: supabase/tests/r1711_cancel_keeps_invoice_due.test.sql (rolled back).

begin;

create or replace function public.cancel_subscription(
  p_subscription_id uuid,
  p_last_day        date,
  p_reason          text,
  p_clear_due       boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-455 + R-1711: end a subscription; a due an open GST invoice asks for is never cleared here. */
declare
  v_tenant    uuid := public.current_tenant_id();
  v_sub       record;
  v_last      date := coalesce(p_last_day, (now() at time zone 'Asia/Kolkata')::date);
  v_end       date;
  v_cleared   integer := 0;
  v_owed      integer;
  v_inv_due   integer := 0;
  v_inv_ids   text[]  := '{}';
  v_kept      integer := 0;
begin
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Write why the subscription is ending (at least 5 characters) — it is kept on the record.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'Subscription not found — refresh the page; it may have been deleted.';
  end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated'))
     or (v_tenant is not null and v_sub.tenant_id is distinct from v_tenant) then
    raise exception 'Subscription not in your workspace' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(auth.role(), '') in ('anon', 'authenticated')
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can cancel a subscription — it takes it out of MRR and renewals. Ask one of them (Subscriptions → the subscription → Cancel subscription).'
      using errcode = 'insufficient_privilege';
  end if;
  if v_sub.status = 'cancelled' then
    raise exception 'This subscription is already cancelled. To bring it back, use Correct details → Status.'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sub.start_date is not null and v_last < v_sub.start_date then
    raise exception 'The last day (%) is before the subscription started (%). Pick a date on or after the start.', v_last, v_sub.start_date
      using errcode = 'invalid_parameter_value';
  end if;

  v_owed := greatest(0, coalesce(v_sub.outstanding_amount, 0));
  if p_clear_due and v_owed > 0 then
    /* R-1711: what this subscription's OPEN invoices still ask for (write_off_subscription's match). */
    select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0))), 0)::integer,
           coalesce(array_agg(i.id order by i.id), '{}')
      into v_inv_due, v_inv_ids
      from public.invoices i
     where i.tenant_id = v_sub.tenant_id
       and i.status::text in ('pending', 'overdue')
       and i.written_off_at is null
       and greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) > 0
       and (   (v_sub.quote_id is not null and i.quote_id = v_sub.quote_id)
            or (v_sub.renewal_quote_id is not null and i.quote_id = v_sub.renewal_quote_id)
            or exists (select 1 from public.subscription_billings b
                        where b.subscription_id = v_sub.id and b.tenant_id = v_sub.tenant_id and b.invoice_id = i.id));

    v_kept    := least(v_owed, v_inv_due);
    v_cleared := v_owed - v_kept;
    if v_cleared = 0 then
      raise exception 'The % still due is on open invoice % — clearing it here would leave that GST invoice asking for money the subscription says is not owed. Issue a credit note for the unused part on the invoice first (CGST s.34), then cancel; or cancel without clearing if the customer still has to pay.',
        '₹' || to_char(v_owed, 'FM99,99,99,999'), array_to_string(v_inv_ids, ', ')
        using errcode = 'invalid_parameter_value';
    end if;
  end if;
  v_end := case when v_sub.renewal_date is null or v_last < v_sub.renewal_date then v_last else v_sub.renewal_date end;

  update public.subscriptions
     set status             = 'cancelled',
         auto_renew         = false,
         renewal_date       = v_end,
         outstanding_amount = case when v_cleared > 0 then outstanding_amount - v_cleared else outstanding_amount end,
         cancelled_at       = now(),
         cancel_reason      = left(trim(p_reason), 500),
         cancel_due_cleared = v_cleared
   where id = p_subscription_id;

  return jsonb_build_object(
    'subscription_id', p_subscription_id,
    'status',          'cancelled',
    'last_day',        v_end,
    'due_cleared',     v_cleared,
    'due_kept',        v_kept,
    'open_invoices',   to_jsonb(case when v_kept > 0 then v_inv_ids else '{}'::text[] end)
  );
end $$;

comment on function public.cancel_subscription(uuid, date, text, boolean) is
  'R-455 + R-1711: end a real subscription (status cancelled, auto_renew off, renewal_date = last day). p_clear_due closes the due no open invoice asks for (kept in cancel_due_cleared); a due on an open invoice needs a credit note first — refused when nothing else is left to clear. Deletes nothing. owner/manager/accountant.';

revoke all on function public.cancel_subscription(uuid, date, text, boolean) from public, anon;
grant execute on function public.cancel_subscription(uuid, date, text, boolean) to authenticated, service_role;

commit;
