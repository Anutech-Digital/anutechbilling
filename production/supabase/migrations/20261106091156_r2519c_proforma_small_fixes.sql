-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.cancel_quote(text,text)') and prosrc like '%R-2519c%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quotes_proforma_columns_guarded()') and prosrc like '%R-2519c%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_payment_closed_quote_guard()') and prosrc like '%R-2519c%') and exists(select 1 from pg_trigger where tgname = 'trg_quotes_part_request_never_deleted')
-- deploy-key: r2519cproformasmallfixes
-- 20261106091156_r2519c_proforma_small_fixes.sql
--
-- R-2519 re-review v14 (SAFE) — small follow-ups:
--   1. trg_quotes_part_request_never_deleted: a signed-in user cannot DELETE a part request or a cancelled
--      one (subscription_billing_id / cancelled_part_billing_id) — it is only ever cancelled. Server code
--      (tenant wipe, scenario reset) is not a direct request login and is not stopped.
--   2. cancel_quote (body of 20261106074318 R-2519b): also refused when a LATER TERM's row is laid,
--      even unbilled (monthly Flexible: the billing job bills only the current term — probe S3).
--   3. trg_quotes_proforma_columns_guarded (body of 20261106074318): the current_request_role() =
--      'service_role' test is gone — in a raw session a forged JWT claim passed it. Only the login decides.
--   4. tg_payment_closed_quote_guard (body of 20261018165435 R-1575): a CANCELLED quote's refusal says
--      "Undo cancel", not "Reopen" (Reopen is refused for it).
-- Test: supabase/tests/r2519c_proforma_small_fixes.test.sql (one transaction, rolled back).

begin;

create or replace function public.tg_quotes_proforma_columns_guarded()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  /* R-2519c: trusts only the login, never a claim. R-2519b (independent review, BLOCK): INSERT too. A signed-in user could INSERT a quote already
     carrying subscription_billing_id + proforma seats (or a fake cancelled row) and accept it. Only
     server code writes these columns: a SECURITY DEFINER function (current_user is its owner), the
     service role, or a direct DB session. A client request is a direct request login
     (public.is_direct_request_login, R-2485). No settable flag is trusted — any session can SET one. */
  /* R-2519c: no role-claim test — a forged JWT 'service_role' claim on a client login passed it.
     The service role key itself is not a direct request login, so it still passes here. */
  if not public.is_direct_request_login() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.proforma_seats is not null or new.proforma_seat_rate is not null
       or new.proforma_terms_applied_at is not null or new.proforma_terms_set_at is not null or new.proforma_terms_set_by is not null
       or new.cancelled_at is not null or new.cancelled_by is not null or new.cancel_reason is not null
       or new.cancelled_from_status is not null or new.cancelled_payment_status is not null
       or new.cancelled_part_billing_id is not null or new.subscription_billing_id is not null then
      raise exception 'A proforma for a subscription part is made only by Bill next part — these fields cannot be set by hand.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.proforma_seats is distinct from old.proforma_seats
     or new.proforma_seat_rate is distinct from old.proforma_seat_rate
     or new.proforma_terms_applied_at is distinct from old.proforma_terms_applied_at
     or new.proforma_terms_set_at is distinct from old.proforma_terms_set_at
     or new.proforma_terms_set_by is distinct from old.proforma_terms_set_by
     or new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_by is distinct from old.cancelled_by
     or new.cancel_reason is distinct from old.cancel_reason
     or new.cancelled_from_status is distinct from old.cancelled_from_status
     or new.cancelled_payment_status is distinct from old.cancelled_payment_status
     or new.cancelled_part_billing_id is distinct from old.cancelled_part_billing_id
     or new.subscription_billing_id is distinct from old.subscription_billing_id then
    raise exception 'These proforma fields change only through Bill next part, Cancel or Undo cancel.' using errcode = '42501';
  end if;
  return new;
end;
$$;


create or replace function public.tg_quotes_part_request_never_deleted()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  /* R-2519c: a proforma for a subscription part (open or cancelled) is cancelled, never deleted. */
  if public.is_direct_request_login()
     and (old.subscription_billing_id is not null or old.cancelled_part_billing_id is not null) then
    raise exception 'Quote % is a proforma for a subscription part — it is never deleted. Use More → Cancel proforma instead.', old.id
      using errcode = '22023';
  end if;
  return old;
end;
$$;
revoke all on function public.tg_quotes_part_request_never_deleted() from public, anon, authenticated;
drop trigger if exists trg_quotes_part_request_never_deleted on public.quotes;
create trigger trg_quotes_part_request_never_deleted
  before delete on public.quotes
  for each row execute function public.tg_quotes_part_request_never_deleted();

create or replace function public.cancel_quote(p_quote_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2519c: also refused when a later term is laid. R-2519b: refused while a later period's proforma is open. R-2519: cancel an unpaid quote / proforma. The subscription is not touched. */
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
    /* R-2519c (re-review S3): a LATER TERM's row already laid (even unbilled) — the billing job bills
     only the current term, so this earlier period would never be billed again. */
    if v_later is null then
      select string_agg(to_char(b2.period_start, 'FMDD Mon YYYY'), ', ' order by b2.period_start) into v_later
        from public.subscription_billings b
        join public.subscription_billings b2 on b2.subscription_id = b.subscription_id and b2.term_start > b.term_start
       where b.id = v_q.subscription_billing_id;
      if v_later is not null then
        raise exception 'The next term (from %) is already laid for billing, so this earlier period could not be billed again — keep this proforma (or change its seats), do not cancel it.', v_later
          using errcode = '22023';
      end if;
    end if;
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

create or replace function public.tg_payment_closed_quote_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_q record;
begin
  select q.id, q.status, q.superseded_by, q.cancelled_at into v_q
    from public.quotes q
   where q.id = new.quote_id;
  if not found then
    return new;
  end if;
  if v_q.superseded_by is not null then
    raise exception 'Quote % was replaced by % (R-1575), so it can''t take a payment. Record this payment on quote % instead (Quotes → % → Record payment).',
      v_q.id, v_q.superseded_by, v_q.superseded_by, v_q.superseded_by
      using errcode = 'check_violation';
  end if;
  /* R-2519c: a CANCELLED quote / proforma is reopened with Undo cancel (Reopen is refused for it). */
  if v_q.cancelled_at is not null then
    raise exception 'Quote % was cancelled (R-2519), so it can''t take a payment. Open it and use More → Undo cancel (back to Sent), then record the payment.',
      v_q.id
      using errcode = 'check_violation';
  end if;
  if v_q.status = 'rejected' then
    raise exception 'Quote % was rejected (R-1575), so it can''t take a payment. If the customer went ahead after all, open the quote and press Reopen (back to Sent), then record the payment — or make a new quote.',
      v_q.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.cancel_quote(text, text) from public, anon;
grant execute on function public.cancel_quote(text, text) to authenticated, service_role;

commit;
