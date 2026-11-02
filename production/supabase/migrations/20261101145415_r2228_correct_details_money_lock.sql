-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.correct_subscription_data(uuid,integer,integer,text)') and prosrc like '%R-2228%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.correct_subscription_terms(uuid,text,integer,integer,text)') and prosrc like '%R-2228%')
-- deploy-key: r2228correctdetailslock
-- 20261101145415_r2228_correct_details_money_lock.sql
--
-- R-2228 (Zoho Billing audit A4, 31 Oct 2026): "Correct details" let anyone with a price role
-- change seats and MRR with no bill or credit, so the subscription, its invoices and the Google
-- admin drifted apart. Seats change through Manage seats (bills / credits the change); status
-- through Suspend / Cancel / Won't renew.
--
-- ══ WHAT CHANGES ══════════════════════════════════════════════════════════════════════════
--   1. correct_subscription_terms (R-1684, 20261024030954) — same body, but a seats or MRR value
--      different from the record is now REFUSED (42501) for every caller: this door corrects the
--      plan (catalog row) only. Nothing changed / plan-only behave exactly as before.
--   2. correct_subscription_data(sub, seats, mrr, reason) — the ONE owner-only "Data correction"
--      door for seats / MRR (coordinator decision: the Zoho reconcile clean-up needs it). Owner
--      only (managers, accountants, billing refused 42501); reason of 10+ characters (22023);
--      company-checked (§17c); one activity_log row 'subscription.data_correction' with
--      old → new; the reason also lands on the contract_amendments row (app.amendment_note,
--      transaction-local, as R-1684). NO money is posted — it is a record fix, not a sale: no
--      invoice, quote, credit note or journal.
--   Status has no RPC path here at all (the dialog no longer sends it).
--
-- Proof: supabase/tests/r2228_correct_details_money_lock.test.sql (one rollback; red without
-- this migration — step 1 accepts the seat change, step 3 has no function).

begin;

create or replace function public.correct_subscription_terms(
  p_subscription_id uuid,
  p_item_id         text,
  p_seats           integer,
  p_mrr             integer,
  p_reason          text
) returns void
language plpgsql
security definer
set search_path = public
as $$
/* R-1684; R-2228: seats / MRR are no longer corrected here (Manage seats, or the owner's
   correct_subscription_data). */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean;
  v_sub     record;
  v_item    record;
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
  v_plan    text;
  v_item_id text;
  v_seats   integer;
  v_mrr     integer;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in again, then correct the subscription.' using errcode = '28000';
  end if;

  select s.id, s.tenant_id, s.plan, s.item_id, s.seats, s.mrr
    into v_sub
    from public.subscriptions s
   where s.id = p_subscription_id
   for update;
  if not found or (v_tenant is not null and v_sub.tenant_id <> v_tenant) then
    raise exception 'That subscription was not found in your company. Refresh the page and try again.'
      using errcode = '42501';
  end if;

  v_seats := coalesce(p_seats, v_sub.seats);
  v_mrr   := coalesce(p_mrr, v_sub.mrr);
  /* R-2228: a seat or price change here had no bill and no credit. */
  if v_seats <> v_sub.seats or v_mrr <> v_sub.mrr then
    raise exception 'Seats and MRR are not changed in Correct details. Use Manage seats (it bills or credits the change). To fix a wrong record, the owner uses Data correction with a reason.'
      using errcode = '42501';
  end if;

  v_plan    := v_sub.plan;
  v_item_id := v_sub.item_id;
  if p_item_id is not null and p_item_id is distinct from v_sub.item_id then
    select i.id, i.name into v_item
      from public.items i
     where i.id = p_item_id and i.tenant_id = v_sub.tenant_id and i.is_active;
    if not found then
      raise exception 'Pick the plan from your catalog (Items). That product is not in this company''s active catalog.'
        using errcode = '22023';
    end if;
    v_plan    := v_item.name;
    v_item_id := v_item.id;
  end if;

  if v_plan is not distinct from v_sub.plan and v_item_id is not distinct from v_sub.item_id then
    return;   -- nothing to correct
  end if;

  if not v_trusted and not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can change the plan. Ask one of them.'
      using errcode = '42501';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Write why the plan is being corrected. The reason is kept in the subscription''s change history.'
      using errcode = '22023';
  end if;

  perform set_config('app.amendment_note', left(v_reason, 500), true);
  update public.subscriptions
     set plan = v_plan, item_id = v_item_id
   where id = v_sub.id;
  perform set_config('app.amendment_note', '', true);
end;
$$;

revoke all on function public.correct_subscription_terms(uuid, text, integer, integer, text) from public, anon;
grant execute on function public.correct_subscription_terms(uuid, text, integer, integer, text) to authenticated, service_role;

create or replace function public.correct_subscription_data(
  p_subscription_id uuid,
  p_seats           integer,
  p_mrr             integer,
  p_reason          text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2228: owner-only Data correction of seats / MRR — a record fix, never a sale. */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean;
  v_sub     record;
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
  v_seats   integer;
  v_mrr     integer;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in again, then correct the subscription.' using errcode = '28000';
  end if;

  if not v_trusted and not public.current_user_has_role('owner') then
    raise exception 'Only the owner can make a data correction to seats or MRR. Use Manage seats to bill or credit a change.'
      using errcode = '42501';
  end if;

  select s.id, s.tenant_id, s.customer_name, s.plan, s.seats, s.mrr
    into v_sub
    from public.subscriptions s
   where s.id = p_subscription_id
   for update;
  if not found or (v_tenant is not null and v_sub.tenant_id <> v_tenant) then
    raise exception 'That subscription was not found in your company. Refresh the page and try again.'
      using errcode = '42501';
  end if;

  v_seats := coalesce(p_seats, v_sub.seats);
  v_mrr   := coalesce(p_mrr, v_sub.mrr);
  if v_seats < 0 or v_mrr < 0 then
    raise exception 'Seats and MRR cannot be below zero.' using errcode = '22023';
  end if;

  if v_seats = v_sub.seats and v_mrr = v_sub.mrr then
    return jsonb_build_object('subscription_id', v_sub.id, 'changed', false);
  end if;

  if v_reason is null or length(v_reason) < 10 then
    raise exception 'Write why the record is wrong (at least 10 characters). It is kept in the activity log.'
      using errcode = '22023';
  end if;

  perform set_config('app.amendment_note', left('Data correction: ' || v_reason, 500), true);
  update public.subscriptions
     set seats = v_seats, mrr = v_mrr
   where id = v_sub.id;
  perform set_config('app.amendment_note', '', true);

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_sub.tenant_id, (select u.id from public.users u where u.id = auth.uid()),
          'subscription.data_correction', 'subscription', v_sub.id::text,
          left(format('Data correction — %s · %s: seats %s → %s, MRR %s → %s',
                      v_sub.customer_name, coalesce(nullif(btrim(v_sub.plan), ''), 'subscription'),
                      v_sub.seats, v_seats, v_sub.mrr, v_mrr), 120),
          jsonb_build_object('seats', jsonb_build_object('from', v_sub.seats, 'to', v_seats),
                             'mrr',   jsonb_build_object('from', v_sub.mrr,   'to', v_mrr),
                             'reason', v_reason));

  return jsonb_build_object('subscription_id', v_sub.id, 'changed', true,
                            'seats_from', v_sub.seats, 'seats_to', v_seats,
                            'mrr_from', v_sub.mrr, 'mrr_to', v_mrr);
end;
$$;

comment on function public.correct_subscription_data(uuid, integer, integer, text) is
  'R-2228: owner-only Data correction of a subscription''s seats / MRR (record fix, no money posted). Reason 10+ characters, company-checked, one activity_log row with old → new; reason also on the contract_amendments note.';

revoke all on function public.correct_subscription_data(uuid, integer, integer, text) from public, anon;
grant execute on function public.correct_subscription_data(uuid, integer, integer, text) to authenticated, service_role;

commit;
