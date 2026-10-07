-- R-096 (7 Oct 2026): a portal customer's seat / price / plan change no longer dies on
-- contract_amendments_changed_by_fkey, and the amendment names them as "Customer <name>".
--
-- BUG: record_contract_amendment() (trigger on subscriptions, 20260816170000) wrote
-- changed_by = auth.uid(). changed_by references public.users(id), but a portal customer
-- signs in as a customer_users row, NOT a public.users row. So the day a portal/DMS
-- customer changes seats, price or plan through a SECURITY DEFINER RPC, the amendment
-- insert fails the FK and the customer's whole change rolls back. Found during R-016,
-- which fixed the same bug in log_row_change() (20260930200001). Not hit yet: the only
-- customer write today (auto-renew toggle) is not a commercial field.
--
-- FIX (same approach as R-016):
--   * staff (in public.users)          -> changed_by = auth.uid(), actor_label null (as before)
--   * portal customer (customer_users) -> changed_by null, actor_label 'Customer <customers.name>'
--   * any other JWT                    -> changed_by null, actor_label null (recorded, not failed)
--   * no JWT (cron / service role)     -> changed_by null, source 'system' (as before)
-- source stays 'user' for anyone signed in. The FK stays: it joins a staff row to a name.
-- Body otherwise identical to 20260816170000. Trigger unchanged (same function name).
--
-- Test: supabase/tests/contract_amendment_customer_actor.test.sql (rolled back).

alter table public.contract_amendments add column if not exists actor_label text;

comment on column public.contract_amendments.actor_label is
  'Who did it, when the actor is not a staff user (changed_by is null) - e.g. ''Customer Acme Pvt Ltd'' for a portal customer. Null for staff and system rows.';

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
  end if;

  insert into public.contract_amendments (
    tenant_id, subscription_id, customer_name, kind, changes,
    seats_from, seats_to, mrr_from, mrr_to, changed_by, actor_label, source
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
    case when v_uid is null then 'system' else 'user' end
  );

  return new;
end;
$$;

comment on function public.record_contract_amendment() is
  'Writes an amendment row when a subscription''s COMMERCIAL terms move. changed_by = staff user id; a portal customer gets changed_by null + actor_label ''Customer <name>'' (R-096).';
