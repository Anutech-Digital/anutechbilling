-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'leave_reason_code')
-- deploy-key: r2243leavereason
-- 20261117051500_r2243_leave_reason.sql
--
-- R-2243 (Zoho Billing study, idea 2): WHY customers leave, as a fixed list that can be counted.
--
-- Until now the reason for Cancel subscription (cancel_reason) and Won't renew (non_renew_reason) was
-- free text of 5+ characters — nobody could count "left on price". This adds ONE column,
-- subscriptions.leave_reason_code, written by BOTH functions, and the picklist the app shows:
--   price · competitor · other_suite · closed · downsized · not_using · payment · other
-- (labels live in src/lib/subscriptions/leave-reasons.ts — keep in step with the check below).
-- The free-text columns stay and keep the readable sentence ("Price too high — found it cheaper"), so
-- every screen that already shows the reason is unchanged. Rows from before this card keep a NULL code
-- and read "Not recorded". Undo of Won't renew clears the code with the reason. A subscription that was
-- Won't renew and is cancelled later carries the cancel's code (one fact, one place).
--
-- The picker is required in the app's two dialogs. The database checks a code when one is sent (it must
-- be in the list; "Other" needs a note after the label) but does not force one, so older callers and
-- the service jobs keep working.
--
-- cancel_subscription / set_subscription_non_renewing get one trailing parameter, so the old signature is
-- dropped first (a second overload would make a 4-argument call ambiguous). Bodies are the CURRENT ones
-- (R-1819 §17c / R-2225) with only the code added — no money rule changes. RLS unchanged; the new column
-- is read like the table's others; EXECUTE grants are explicit below.

begin;

alter table public.subscriptions
  add column if not exists leave_reason_code text;

alter table public.subscriptions
  drop constraint if exists subscriptions_leave_reason_code_check;
alter table public.subscriptions
  add constraint subscriptions_leave_reason_code_check
  check (leave_reason_code is null or leave_reason_code in
    ('price', 'competitor', 'other_suite', 'closed', 'downsized', 'not_using', 'payment', 'other'));

comment on column public.subscriptions.leave_reason_code is
  'R-2243: why the customer left — picklist code set by cancel_subscription() and set_subscription_non_renewing(). NULL = not recorded (before R-2243) or still renewing.';

-- The one check both functions share. "Other" must carry a note after the label ("Other — went abroad").
create or replace function public.r2243_check_leave_reason(p_code text, p_reason text)
returns void
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_code is null then
    return;
  end if;
  if p_code not in ('price', 'competitor', 'other_suite', 'closed', 'downsized', 'not_using', 'payment', 'other') then
    raise exception 'Pick a reason from the list (got %).', p_code using errcode = 'invalid_parameter_value';
  end if;
  if p_code = 'other'
     and length(btrim(regexp_replace(coalesce(p_reason, ''), '^\s*other\s*[—–:-]?\s*', '', 'i'))) < 5 then
    raise exception 'Write a short note for "Other" (at least 5 characters) — it is kept on the record.'
      using errcode = 'invalid_parameter_value';
  end if;
end $$;

revoke all on function public.r2243_check_leave_reason(text, text) from public, anon;
grant execute on function public.r2243_check_leave_reason(text, text) to authenticated, service_role;

drop function if exists public.cancel_subscription(uuid, date, text, boolean);
drop function if exists public.set_subscription_non_renewing(uuid, boolean, text, date);

create or replace function public.cancel_subscription(
  p_subscription_id uuid,
  p_last_day        date,
  p_reason          text,
  p_clear_due       boolean default false,
  p_reason_code     text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-455 + R-1711 + R-2243: end a subscription; a due an open GST invoice asks for is never cleared here. */
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
  v_r1819_trusted boolean;
  v_code      text := nullif(btrim(coalesce(p_reason_code, '')), '');
begin
  perform public.r2243_check_leave_reason(v_code, p_reason);
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Write why the subscription is ending (at least 5 characters) — it is kept on the record.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'Subscription not found — refresh the page; it may have been deleted.';
  end if;
  /* R-1819 (security audit 24 Oct 2026): §17c — trusted is named, everyone else needs a company
     and the role. Was: the checks ran only for a request role of anon/authenticated, so a session
     with no request role from the app's own login skipped both. */
  v_r1819_trusted := coalesce(auth.role(), '') = 'service_role'
                     or (auth.role() is null
                         and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_r1819_trusted then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if (v_tenant is not null or not v_r1819_trusted) and v_sub.tenant_id is distinct from v_tenant then
    raise exception 'Subscription not in your workspace' using errcode = 'insufficient_privilege';
  end if;
  if not v_r1819_trusted
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
         leave_reason_code  = v_code,
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

comment on function public.cancel_subscription(uuid, date, text, boolean, text) is
  'R-455 + R-1711 + R-1819 + R-2243: end a real subscription (status cancelled, auto_renew off, renewal_date = last day) and keep the reason code. p_clear_due closes the due no open invoice asks for; a due on an open invoice needs a credit note first. Deletes nothing. owner/manager/accountant.';

revoke all on function public.cancel_subscription(uuid, date, text, boolean, text) from public, anon;
grant execute on function public.cancel_subscription(uuid, date, text, boolean, text) to authenticated, service_role;

create or replace function public.set_subscription_non_renewing(
  p_subscription_id uuid,
  p_on              boolean,
  p_reason          text default null,
  p_said_on         date default null,
  p_reason_code     text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2225 + R-2243: Won't renew (auto_renew off + reason + reason code + date said) and its Undo. */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_sub     record;
  v_said    date := coalesce(p_said_on, (now() at time zone 'Asia/Kolkata')::date);
  v_reason  text := left(btrim(coalesce(p_reason, '')), 500);
  v_trusted boolean;
  v_code    text := nullif(btrim(coalesce(p_reason_code, '')), '');
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

    perform public.r2243_check_leave_reason(v_code, v_reason);

    update public.subscriptions
       set auto_renew        = false,
           leave_reason_code = v_code,
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
            jsonb_build_object('auto_renew', false, 'reason', v_reason, 'reason_code', v_code, 'said_on', v_said,
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
         leave_reason_code = null,
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

comment on function public.set_subscription_non_renewing(uuid, boolean, text, date, text) is
  'R-2225 + R-2243: Won''t renew (auto_renew off + reason + reason code + date the customer said; the cron makes no renewal quote and lapses it after the term) and its Undo. owner/manager/accountant, company-checked (§17c). One activity_log row each way.';

revoke all on function public.set_subscription_non_renewing(uuid, boolean, text, date, text) from public, anon;
grant execute on function public.set_subscription_non_renewing(uuid, boolean, text, date, text) to authenticated, service_role;

commit;
