-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.cancel_quote(text,text)') and prosrc like '%R-2519d%') and to_regprocedure('public.freed_parts_due(date)') is not null
-- deploy-key: r2519dfreedpartsfirst
-- 20261106095909_r2519d_freed_parts_first.sql
--
-- R-2519 (coordinator, after re-review v14): BITDECENTRO must be able to cancel the wrong Oct proforma
-- Q-A378-27-0947 although the Nov row is already laid. R-2519c refused that (any later TERM row laid);
-- this replaces it:
--   cancel_quote (body of 20261106091156 R-2519c): the LATEST REQUESTED period may be cancelled while
--     later rows are only laid (no proforma, no invoice). A later period WITH a proforma or a tax
--     invoice still refuses ("cancel the later one(s) first").
--   freed_parts_due(day): the laid rows whose proforma was cancelled and that have no new proforma and no
--     tax invoice, due by that day, of active subscriptions — earliest first. The billing job bills
--     these BEFORE each subscription's current term (and Bill next part bills the earliest freed row
--     first), so a freed period is never left unbilled. SECURITY INVOKER: RLS scopes a signed-in user
--     to their company; the cron runs as the service role.
-- Test: supabase/tests/r2519c_proforma_small_fixes.test.sql S3 (BITDECENTRO shape) and r2519b M.

begin;

create or replace function public.cancel_quote(p_quote_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2519d: a later row only laid does not refuse (the freed row is billed first). R-2519b: refused while a later period's proforma is open. R-2519: cancel an unpaid quote / proforma. The subscription is not touched. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_later   text;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can cancel a quote.' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'Write why it is cancelled (at least 5 characters) — it is kept on the record.' using errcode = '22023';
  end if;
  select q.* into v_q from public.quotes q where q.id = p_quote_id for update;
  if not found then
    raise exception 'Quote % not found.', p_quote_id using errcode = 'no_data_found';
  end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in your company.', p_quote_id using errcode = '42501';
  end if;
  if v_q.cancelled_at is not null then
    raise exception 'Quote % is already cancelled.', v_q.id using errcode = '22023';
  end if;
  if v_q.status::text in ('rejected', 'expired') or v_q.superseded_by is not null then
    raise exception 'Quote % is already closed.', v_q.id using errcode = '22023';
  end if;
  if v_q.invoice_id is not null
     or exists (select 1 from public.invoices i where i.quote_id = v_q.id and i.status::text <> 'void')
     or (v_q.subscription_billing_id is not null and exists (
           select 1 from public.subscription_billings b where b.id = v_q.subscription_billing_id and b.invoice_id is not null)) then
    raise exception 'Quote % already has a tax invoice — cancel that with a credit note instead.', v_q.id using errcode = '22023';
  end if;
  if exists (select 1 from public.payments p where p.quote_id = v_q.id and p.status = 'received' and p.amount > 0) then
    raise exception 'Money was already received on % — refund it first, or record the rest.', v_q.id using errcode = '22023';
  end if;
  /* R-2519b: only the LATEST billed period of a subscription is freed. With a later period billed
     (a proforma, paid or not, or its tax invoice) the billing job — which bills only the current
     term — would never bill the freed earlier one again. */
  if v_q.subscription_billing_id is not null then
    select string_agg(coalesce(q2.id, b2.invoice_id), ', ' order by b2.period_start) into v_later
      from public.subscription_billings b
      join public.subscription_billings b2 on b2.subscription_id = b.subscription_id and b2.period_start > b.period_start
      left join public.quotes q2 on q2.subscription_billing_id = b2.id and q2.tenant_id = v_q.tenant_id
     where b.id = v_q.subscription_billing_id
       and (q2.id is not null or b2.invoice_id is not null);
    /* R-2519d (coordinator): a later row that is only LAID (no proforma, no invoice) does not stop the
       cancel — the billing job and Bill next part bill the earliest freed row first (freed_parts_due). */
    if v_later is not null then
      raise exception 'A later period of this subscription is already billed (%) — cancel the later proforma(s) first; a paid or invoiced later period needs a credit note, not a cancel here.', v_later
        using errcode = '22023';
    end if;
  end if;
  if coalesce(v_q.is_add_seats, false) then
    raise exception 'Quote % added seats to a subscription — use Mark rejected, which also takes those seats back.', v_q.id
      using errcode = '22023';
  end if;
  /* Accepted with a seat change → those seats are already on the subscription (apply_part_request_terms). */
  if v_q.proforma_terms_applied_at is not null then
    raise exception 'Proforma % was accepted and its % seats are already on the subscription — change the seats from Manage seats, or record the payment.',
      v_q.id, v_q.proforma_seats using errcode = '22023';
  end if;

  perform set_config('app.r2519_write', 'on', true);
  update public.quotes
     set cancelled_from_status = v_q.status::text,
         cancelled_payment_status = v_q.payment_status::text,
         cancelled_part_billing_id = v_q.subscription_billing_id,
         subscription_billing_id = null,
         status = 'rejected',
         payment_status = 'none',
         cancelled_at = now(),
         cancelled_by = auth.uid(),
         cancel_reason = v_reason,
         notes = concat_ws(E'\n', nullif(notes, ''), 'Cancelled — ' || v_reason || ' (' || to_char(public.ist_today(), 'DD Mon YYYY') || ').')
   where id = v_q.id;
  perform set_config('app.r2519_write', '', true);
  /* The part(s) are free to be billed again — their due date was this request's (a group request
     names every part on its lines: billing_id). */
  if v_q.subscription_billing_id is not null then
    update public.subscription_billings
       set due_on = null, request_reminder_step = null, updated_at = now()
     where invoice_id is null and tenant_id = v_q.tenant_id
       and (id = v_q.subscription_billing_id
            or id::text in (select l->>'billing_id' from jsonb_array_elements(coalesce(v_q.line_items, '[]'::jsonb)) l
                             where l ? 'billing_id'));
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_q.tenant_id, (select u.id from public.users u where u.id = auth.uid()),
          'quote.cancelled', 'quote', v_q.id,
          left(format('Cancelled %s — %s', v_q.id, v_reason), 120),
          jsonb_build_object('status', jsonb_build_object('from', v_q.status::text, 'to', 'cancelled'), 'reason', v_reason));

  return jsonb_build_object('quote_id', v_q.id, 'status', 'cancelled', 'part_released', v_q.subscription_billing_id is not null);
end;
$$;

create or replace function public.freed_parts_due(p_today date)
returns table(billing_id uuid, subscription_id uuid, tenant_id uuid, period_start date)
language sql
stable
security invoker
set search_path = public
as $$
  /* R-2519d: freed (cancelled) parts still to bill, earliest first. */
  select b.id, b.subscription_id, b.tenant_id, b.period_start
    from public.subscription_billings b
    join public.subscriptions s on s.id = b.subscription_id and s.status = 'active'
   where b.invoice_id is null
     and b.bill_on <= p_today
     and exists (select 1 from public.quotes c where c.cancelled_part_billing_id = b.id)
     and not exists (select 1 from public.quotes q where q.subscription_billing_id = b.id)
   order by b.period_start, b.id;
$$;
revoke all on function public.freed_parts_due(date) from public, anon;
grant execute on function public.freed_parts_due(date) to authenticated, service_role;


revoke all on function public.cancel_quote(text, text) from public, anon;
grant execute on function public.cancel_quote(text, text) to authenticated, service_role;

commit;
