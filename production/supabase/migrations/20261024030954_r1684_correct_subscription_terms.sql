-- deploy-peek: to_regprocedure('public.correct_subscription_terms(uuid,text,integer,integer,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_contract_amendment()') and prosrc like '%R-1684%')
-- deploy-key: r1684correctsubterms
-- 20261024030954_r1684_correct_subscription_terms.sql
--
-- R-1684 (P2 money): "Correct details" on a subscription wrote seats / plan / price straight
-- into the table. Staging 19 Oct (T-12): an annual commitment went 15 → 10 seats mid-term with
-- no warning and no reason, MRR stayed ₹16,200 (so MRR and the next-term bill disagreed), and
-- the plan box was free text (Standard → "Starter" or anything).
--
-- WHAT THIS MIGRATION DOES
--   1. correct_subscription_terms(sub, item_id, seats, mrr, reason) — the one door the dialog
--      uses for the COMMERCIAL fields (plan, seats, price):
--        * company check (current_tenant_id) — trusted server paths as everywhere (R-454);
--        * a reason is required (3+ characters) — it lands on the amendment row (note);
--        * cutting seats or changing the plan: owner / manager only. A price-only correction or
--          adding seats: owner / manager / accountant / billing (R-885's record group);
--        * the plan comes from the catalog: p_item_id must be an active `items` row of the same
--          company; plan := that row's name, item_id := its id. Null = keep the current plan;
--        * nothing changed → nothing written.
--   2. record_contract_amendment(): the same body (20261007240000) + note :=
--      current_setting('app.amendment_note', true), which only (1) sets, transaction-local.
--
-- NOT CHANGED: no stored row. The table path (other dialogs, crons) is unchanged — see the card's
-- needsDecision for whether a direct seat cut should be refused at the table too.
--
-- Proof: supabase/tests/r1684_correct_subscription.test.sql (one rollback on local Docker; without
-- this migration it FAILs at step 1).

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
/* R-1684 */
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

  v_seats := coalesce(p_seats, v_sub.seats);
  v_mrr   := coalesce(p_mrr, v_sub.mrr);
  if v_seats < 0 or v_mrr < 0 then
    raise exception 'Seats and price cannot be below zero.' using errcode = '22023';
  end if;

  if v_plan is not distinct from v_sub.plan and v_item_id is not distinct from v_sub.item_id
     and v_seats = v_sub.seats and v_mrr = v_sub.mrr then
    return;   -- nothing to correct
  end if;

  if not v_trusted then
    if (v_seats < v_sub.seats or v_plan is distinct from v_sub.plan)
       and not public.current_user_has_role('owner', 'manager') then
      raise exception 'Only an owner or manager can cut seats or change the plan. Ask one of them.'
        using errcode = '42501';
    end if;
    if not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
      raise exception 'Only an owner, manager, accountant or billing user can correct the seats or price.'
        using errcode = '42501';
    end if;
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Write why the seats, plan or price are being corrected. The reason is kept in the subscription''s change history.'
      using errcode = '22023';
  end if;

  perform set_config('app.amendment_note', left(v_reason, 500), true);
  update public.subscriptions
     set plan = v_plan, item_id = v_item_id, seats = v_seats, mrr = v_mrr
   where id = v_sub.id;
  perform set_config('app.amendment_note', '', true);
end;
$$;

revoke all on function public.correct_subscription_terms(uuid, text, integer, integer, text) from public, anon;
grant execute on function public.correct_subscription_terms(uuid, text, integer, integer, text) to authenticated, service_role;

create or replace function public.record_contract_amendment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_kinds   text[] := '{}';
  v_uid     uuid   := auth.uid();
  v_user    uuid;
  v_actor   text;
  v_as      uuid;
begin
  /* Only COMMERCIAL terms. A domain correction or a reminder timestamp is not an
     amendment, and recording every column change would bury the seat history that
     the ledger exists for under cron noise. */
  if new.seats is distinct from old.seats then
    v_changes := v_changes || jsonb_build_object('seats', jsonb_build_object('from', old.seats, 'to', new.seats));
    v_kinds := v_kinds || (case when new.seats > old.seats then 'seats_added' else 'seats_reduced' end)::text;
  end if;

  if new.mrr is distinct from old.mrr then
    v_changes := v_changes || jsonb_build_object('mrr', jsonb_build_object('from', old.mrr, 'to', new.mrr));
    v_kinds := v_kinds || 'price_changed'::text;
  end if;

  if new.plan is distinct from old.plan then
    v_changes := v_changes || jsonb_build_object('plan', jsonb_build_object('from', old.plan, 'to', new.plan));
    v_kinds := v_kinds || 'plan_changed'::text;
  end if;

  if new.renewal_date is distinct from old.renewal_date then
    v_changes := v_changes || jsonb_build_object('renewal_date', jsonb_build_object('from', old.renewal_date, 'to', new.renewal_date));
    v_kinds := v_kinds || 'term_changed'::text;
  end if;

  if new.status is distinct from old.status then
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', old.status, 'to', new.status));
    v_kinds := v_kinds || 'status_changed'::text;
  end if;

  if new.billing_cycle is distinct from old.billing_cycle then
    v_changes := v_changes || jsonb_build_object('billing_cycle', jsonb_build_object('from', old.billing_cycle, 'to', new.billing_cycle));
    v_kinds := v_kinds || 'billing_cycle_changed'::text;
  end if;

  if v_changes = '{}'::jsonb then
    return new;   -- nothing commercial moved
  end if;

  -- R-096: who is acting — a staff user, or a portal customer (not in public.users).
  if v_uid is not null then
    select u.id into v_user from public.users u where u.id = v_uid;
    if v_user is null then
      select 'Customer ' || c.name into v_actor
        from public.customer_users cu
        join public.customers c on c.id = cu.customer_id
       where cu.auth_user_id = v_uid
       limit 1;
    end if;
  else
    -- R-051: an admin-client write made for a signed-in staff user of this tenant.
    v_as := public.audit_service_actor();
    if v_as is not null then
      select u.id into v_user from public.users u where u.id = v_as and u.tenant_id = new.tenant_id;
    end if;
  end if;

  insert into public.contract_amendments (
    tenant_id, subscription_id, customer_name, kind, changes,
    seats_from, seats_to, mrr_from, mrr_to, changed_by, actor_label, source, note
  ) values (
    new.tenant_id, new.id, new.customer_name,
    array_to_string(v_kinds, '+'),
    v_changes,
    case when new.seats is distinct from old.seats then old.seats end,
    case when new.seats is distinct from old.seats then new.seats end,
    case when new.mrr   is distinct from old.mrr   then old.mrr   end,
    case when new.mrr   is distinct from old.mrr   then new.mrr   end,
    v_user,
    left(v_actor, 120),
    case when v_uid is null and v_user is null then 'system' else 'user' end,
    /* R-1684: the reason "Correct details" asked for (correct_subscription_terms sets it,
       transaction-local). Empty / unset elsewhere → null, as before. */
    nullif(current_setting('app.amendment_note', true), '')
  );

  return new;
end;
$$;

comment on function public.record_contract_amendment() is
  'Writes an amendment row when a subscription''s COMMERCIAL terms move. changed_by = staff user id (session, or the service-role asserted actor of the same tenant - R-051); a portal customer gets changed_by null + actor_label ''Customer <name>'' (R-096). R-1684: note = the correction reason from correct_subscription_terms.';

commit;
