-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.set_subscription_non_renewing(uuid,boolean,text,date)') and prosrc like '%R-2225%')
-- deploy-key: r2225nonrenewing
-- 20261101135056_r2225_non_renewing.sql
--
-- R-2225 (Zoho Billing audit A1, 31 Oct 2026): "Won't renew" → Non-renewing.
--
-- A customer says they will not renew. Until now the owner could only cancel at once or live with
-- the renewal chase (Generate / Send now / urgent list) for a subscription that is ending.
--
-- ══ WHAT CHANGES ══════════════════════════════════════════════════════════════════════════
--   1. subscriptions.non_renew_reason / non_renew_said_on / non_renew_set_at / non_renew_set_by —
--      why, when the customer said so, and who recorded it. The flag itself is the existing
--      auto_renew = false (the renewals cron already makes no renewal quote for it and lapses it
--      to 'expired' once renewal_date has passed — RN-24, api/cron/renewals/route.ts).
--   2. set_subscription_non_renewing(sub, on, reason, said_on) — SECURITY DEFINER, §17c guard;
--      owner / manager / accountant (the roles of cancel_subscription — "At end of term" in the
--      Cancel dialog is this same call). on = true needs a reason (5+ characters) and a date not in
--      the future; on = false is the Undo (auto_renew back on, the reason fields cleared).
--      One activity_log row each way ('subscription.non_renewing' / 'subscription.non_renewing_undo').
--   3. nav_badges — in its own file, 20261101135057 (SECURITY INVOKER; the parity test reads the newest file) —
--      R-2023 body (20261027110131), copied exactly; 'renewals' leaves out
--      auto_renew = false, the same rule as the /renewals Urgent tab (classify.ts). The sidebar
--      badge must equal the list it opens (R-1541, lib/hooks/nav-badge-parity.test.ts).
--
-- Proof: supabase/tests/r2225_non_renewing.test.sql (one rollback; red without this migration).

begin;

-- ── 1. Columns ─────────────────────────────────────────────────────────────────────────────
alter table public.subscriptions
  add column if not exists non_renew_reason  text,
  add column if not exists non_renew_said_on date,
  add column if not exists non_renew_set_at  timestamptz,
  add column if not exists non_renew_set_by  uuid references public.users(id) on delete set null;

comment on column public.subscriptions.non_renew_reason is
  'R-2225: why the customer will not renew (Won''t renew). Set with auto_renew = false by set_subscription_non_renewing().';
comment on column public.subscriptions.non_renew_said_on is
  'R-2225: the date the customer said they will not renew.';

-- ── 2. Won't renew / Undo ────────────────────────────────────────────────────────────────
create or replace function public.set_subscription_non_renewing(
  p_subscription_id uuid,
  p_on              boolean,
  p_reason          text default null,
  p_said_on         date default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2225: Won't renew (auto_renew off + reason + date said) and its Undo. */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_sub     record;
  v_said    date := coalesce(p_said_on, (now() at time zone 'Asia/Kolkata')::date);
  v_reason  text := left(btrim(coalesce(p_reason, '')), 500);
  v_trusted boolean;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'Subscription not found — refresh the page; it may have been deleted.';
  end if;
  if (v_tenant is not null or not v_trusted) and v_sub.tenant_id is distinct from v_tenant then
    raise exception 'Subscription not in your workspace' using errcode = 'insufficient_privilege';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can mark a subscription Won''t renew — it takes it out of renewals. Ask one of them.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_sub.status = 'cancelled' then
    raise exception 'This subscription is already cancelled.' using errcode = 'invalid_parameter_value';
  end if;

  if p_on then
    if v_sub.status = 'expired' then
      raise exception 'This subscription has already ended (expired) — there is no renewal left to stop.'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_sub.renewal_date is null then
      raise exception 'This subscription has no renewal date, so there is no term end to stop at. Use Cancel subscription → Now instead.'
        using errcode = 'invalid_parameter_value';
    end if;
    if length(v_reason) < 5 then
      raise exception 'Write why the customer will not renew (at least 5 characters) — it is kept on the record.'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_said > v_today then
      raise exception 'The date the customer told you (%) is in the future. Pick today or an earlier date.', v_said
        using errcode = 'invalid_parameter_value';
    end if;

    update public.subscriptions
       set auto_renew        = false,
           non_renew_reason  = v_reason,
           non_renew_said_on = v_said,
           non_renew_set_at  = now(),
           non_renew_set_by  = (select u.id from public.users u where u.id = auth.uid())
     where id = v_sub.id;

    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (v_sub.tenant_id, (select u.id from public.users u where u.id = auth.uid()),
            'subscription.non_renewing', 'subscription', v_sub.id::text,
            left(format('Won''t renew — %s · %s, ends %s: %s',
                        v_sub.customer_name, coalesce(nullif(btrim(v_sub.plan), ''), 'subscription'),
                        to_char(v_sub.renewal_date, 'FMDD Mon YYYY'), v_reason), 120),
            jsonb_build_object('auto_renew', false, 'reason', v_reason, 'said_on', v_said,
                               'ends_on', v_sub.renewal_date, 'renewal_quote_id', v_sub.renewal_quote_id));

    return jsonb_build_object(
      'subscription_id',  v_sub.id,
      'non_renewing',     true,
      'ends_on',          v_sub.renewal_date,
      'said_on',          v_said,
      'renewal_quote_id', v_sub.renewal_quote_id
    );
  end if;

  -- Undo
  if v_sub.auto_renew then
    return jsonb_build_object('subscription_id', v_sub.id, 'non_renewing', false, 'already', true);
  end if;

  update public.subscriptions
     set auto_renew        = true,
         non_renew_reason  = null,
         non_renew_said_on = null,
         non_renew_set_at  = null,
         non_renew_set_by  = null
   where id = v_sub.id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_sub.tenant_id, (select u.id from public.users u where u.id = auth.uid()),
          'subscription.non_renewing_undo', 'subscription', v_sub.id::text,
          left(format('Will renew again — %s · %s (was: %s)',
                      v_sub.customer_name, coalesce(nullif(btrim(v_sub.plan), ''), 'subscription'),
                      coalesce(v_sub.non_renew_reason, 'Won''t renew')), 120),
          jsonb_build_object('auto_renew', true, 'was_reason', v_sub.non_renew_reason,
                             'was_said_on', v_sub.non_renew_said_on));

  return jsonb_build_object('subscription_id', v_sub.id, 'non_renewing', false, 'already', false);
end $$;

comment on function public.set_subscription_non_renewing(uuid, boolean, text, date) is
  'R-2225: Won''t renew (auto_renew off + reason + date the customer said; the cron makes no renewal quote and lapses it after the term) and its Undo. owner/manager/accountant, company-checked (§17c). One activity_log row each way.';

revoke all on function public.set_subscription_non_renewing(uuid, boolean, text, date) from public, anon;
grant execute on function public.set_subscription_non_renewing(uuid, boolean, text, date) to authenticated, service_role;

commit;
