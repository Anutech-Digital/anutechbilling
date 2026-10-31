-- deploy-peek: to_regprocedure('public.correct_subscription_commitment(uuid,integer,public.billing_cycle,date,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_contract_amendment()') and prosrc like '%R-2095 commitment%')
-- deploy-key: r2095correctsubcommitment
-- 20261030164727_r2095_correct_subscription_commitment.sql
--
-- R-2095 (coordinator 30 Oct, P0 money): an existing subscription's COMMITMENT could not be changed.
-- Venus Infotech is on Google Workspace ANNUAL commitment paid MONTHLY but was booked as
-- "Monthly (Flexible)" — its licence cost (vendor_cost_per_seat_month, written from the sale line,
-- R-378) is the Flexible rate instead of the annual one, so the list shows a false loss.
--
-- WHAT THIS MIGRATION DOES
--   1. correct_subscription_commitment(sub, term_months, billing_cycle, renewal_date, reason) — the
--      one door "Correct details" uses for commitment (term_months: 1 Flexible / 12 Annual / 36) and
--      payment frequency (billing_cycle). The SAME two columns record_payment and Add subscription
--      write for a new subscription — no new model. Rules (lib/subscriptions/commitment-change.ts
--      shows the same on screen):
--        * company check (current_tenant_id); trusted server paths as everywhere (R-454);
--        * reason required (3+ characters) — it lands on the amendment row (note);
--        * Flexible is paid monthly only;
--        * an annual (or 3-year) commitment is NOT shortened while its term is running (22023,
--          names the end date); shortening at all: owner / manager; any other change: owner /
--          manager / accountant / billing;
--        * licence cost := the catalogue tier of the NEW commitment (items.prices.monthly.wholesale
--          for Flexible, falling back to the annual tier; prices.annual.wholesale, else
--          items.wholesale, for a commitment — never the flex tier) — unless the cost is
--          vendor-confirmed (vendor_synced_at set, a real vendor bill), which stays;
--        * seats, mrr (selling rate), domain and start_date are not touched;
--        * renewal_date := p_renewal_date (the screen computes the inclusive term end with
--          termEndInclusive — commitmentRenewal); must be after the start date. Null = keep.
--   2. record_contract_amendment(): the latest body (20261024030954, R-1684) + term_months on the
--      ledger (kind commitment_changed) and, in the SAME update only, vendor_cost_per_seat_month —
--      so a Google-bill cost sync stays out of the contract history as before.
--
-- Proof: supabase/tests/r2095_correct_subscription_commitment.test.sql (one rollback; without this
-- migration it FAILs at the first step — no such function).

begin;

create or replace function public.correct_subscription_commitment(
  p_subscription_id uuid,
  p_term_months     integer,
  p_billing_cycle   public.billing_cycle,
  p_renewal_date    date,
  p_reason          text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2095 commitment */
declare
  v_tenant   uuid := public.current_tenant_id();
  v_trusted  boolean;
  v_sub      record;
  v_prices   jsonb;
  v_whole    numeric;
  v_reason   text := nullif(trim(coalesce(p_reason, '')), '');
  v_term_now integer;
  v_term     integer;
  v_cycle    public.billing_cycle;
  v_renewal  date;
  v_tstart   date;
  v_cost     integer;
  v_annual   numeric;
  v_flex     numeric;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in again, then correct the subscription.' using errcode = '28000';
  end if;

  select s.id, s.tenant_id, s.item_id, s.term_months, s.billing_cycle, s.start_date, s.renewal_date,
         s.vendor_cost_per_seat_month, s.vendor_synced_at
    into v_sub
    from public.subscriptions s
   where s.id = p_subscription_id
   for update;
  if not found or (v_tenant is not null and v_sub.tenant_id <> v_tenant) then
    raise exception 'That subscription was not found in your company. Refresh the page and try again.'
      using errcode = '42501';
  end if;

  v_term_now := coalesce(v_sub.term_months, 12);
  v_term     := coalesce(p_term_months, v_term_now);
  v_cycle    := coalesce(p_billing_cycle, v_sub.billing_cycle, 'yearly');
  v_renewal  := coalesce(p_renewal_date, v_sub.renewal_date);
  if v_term not in (1, 12, 36) then
    raise exception 'Commitment is Flexible (1 month), Annual (12 months) or 3 years (36 months).' using errcode = '22023';
  end if;

  if v_term = v_term_now and v_cycle = coalesce(v_sub.billing_cycle, 'yearly')
     and v_renewal is not distinct from v_sub.renewal_date then
    return jsonb_build_object('changed', false);   -- nothing to correct
  end if;

  if v_term = 1 and v_cycle <> 'monthly' then
    raise exception 'Flexible is paid monthly only. Pick Annual commitment to pay quarterly, half-yearly or yearly.'
      using errcode = '22023';
  end if;
  if v_renewal is not null and v_sub.start_date is not null and v_renewal <= v_sub.start_date then
    raise exception 'The renewal date must be after the start date.' using errcode = '22023';
  end if;

  -- An annual / 3-year commitment is not shortened while its term runs (renewal_date inclusive).
  if v_term < v_term_now then
    v_tstart := case when v_sub.renewal_date is null then v_sub.start_date
                     else ((v_sub.renewal_date + 1) - make_interval(months => v_term_now))::date end;
    if v_tstart is not null and v_sub.renewal_date is not null
       and v_tstart <= public.ist_today() and public.ist_today() <= v_sub.renewal_date then
      raise exception 'An annual commitment cannot be reduced mid-term — the customer committed until %. Change it once this term ends, or keep the commitment and change only the payment frequency.',
        to_char(v_sub.renewal_date, 'DD Mon YYYY')
        using errcode = '22023';
    end if;
  end if;

  if not v_trusted then
    if v_term < v_term_now and not public.current_user_has_role('owner', 'manager') then
      raise exception 'Only an owner or manager can shorten a commitment. Ask one of them.' using errcode = '42501';
    end if;
    if not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
      raise exception 'Only an owner, manager, accountant or billing user can change the commitment or payment frequency.'
        using errcode = '42501';
    end if;
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Write why the commitment or payment frequency is being corrected. The reason is kept in the subscription''s change history.'
      using errcode = '22023';
  end if;

  -- Licence cost from the catalogue tier of the new commitment (commitment-change.ts catalogCostPerSeatMonth).
  v_cost := v_sub.vendor_cost_per_seat_month;
  if v_sub.vendor_synced_at is null and v_sub.item_id is not null and v_term <> v_term_now then
    select i.prices, i.wholesale into v_prices, v_whole
      from public.items i where i.id = v_sub.item_id and i.tenant_id = v_sub.tenant_id;
    if found then
      v_annual := nullif(greatest(coalesce((v_prices -> 'annual' ->> 'wholesale')::numeric, 0), 0), 0);
      if v_annual is null then v_annual := nullif(greatest(coalesce(v_whole, 0), 0), 0); end if;
      v_flex := nullif(greatest(coalesce((v_prices -> 'monthly' ->> 'wholesale')::numeric, 0), 0), 0);
      v_cost := coalesce(round(case when v_term = 1 then coalesce(v_flex, v_annual) else v_annual end)::integer, v_cost);
    end if;
  end if;

  perform set_config('app.amendment_note', left(v_reason, 500), true);
  update public.subscriptions
     set term_months = v_term, billing_cycle = v_cycle, renewal_date = v_renewal,
         vendor_cost_per_seat_month = v_cost
   where id = v_sub.id;
  perform set_config('app.amendment_note', '', true);

  return jsonb_build_object('changed', true, 'term_months', v_term, 'billing_cycle', v_cycle,
                            'renewal_date', v_renewal, 'cost_per_seat_month', v_cost,
                            'cost_from', case when v_sub.vendor_synced_at is not null then 'vendor' else 'catalog' end);
end;
$$;

revoke all on function public.correct_subscription_commitment(uuid, integer, public.billing_cycle, date, text) from public, anon;
grant execute on function public.correct_subscription_commitment(uuid, integer, public.billing_cycle, date, text) to authenticated, service_role;

create or replace function public.record_contract_amendment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2095 commitment: term_months (+ the licence cost moved in the same update) on the ledger. */
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

  /* R-2095 commitment: Flexible ↔ Annual is a contract change. The licence cost goes on the same
     row only when it moved WITH the commitment — a vendor-bill cost sync on its own stays out. */
  if new.term_months is distinct from old.term_months then
    v_changes := v_changes || jsonb_build_object('term_months', jsonb_build_object('from', old.term_months, 'to', new.term_months));
    v_kinds := v_kinds || 'commitment_changed'::text;
    if new.vendor_cost_per_seat_month is distinct from old.vendor_cost_per_seat_month then
      v_changes := v_changes || jsonb_build_object('vendor_cost_per_seat_month',
        jsonb_build_object('from', old.vendor_cost_per_seat_month, 'to', new.vendor_cost_per_seat_month));
    end if;
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
    /* R-1684: the reason "Correct details" asked for (correct_subscription_terms /
       correct_subscription_commitment set it, transaction-local). Empty / unset elsewhere → null. */
    nullif(current_setting('app.amendment_note', true), '')
  );

  return new;
end;
$$;

comment on function public.record_contract_amendment() is
  'Writes an amendment row when a subscription''s COMMERCIAL terms move. changed_by = staff user id (session, or the service-role asserted actor of the same tenant - R-051); a portal customer gets changed_by null + actor_label ''Customer <name>'' (R-096). R-1684: note = the correction reason. R-2095: term_months (commitment) and, with it, the licence cost.';

commit;
