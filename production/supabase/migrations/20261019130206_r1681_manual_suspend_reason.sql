-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'resume_when_paid') and to_regprocedure('public.suspend_subscription(uuid,text,boolean)') is not null and exists(select 1 from pg_trigger where tgname = 'trg_subscriptions_pause_reason' and tgrelid = to_regclass('public.subscriptions')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_invoice_overdue_resume()') and prosrc like '%R-1681%')
-- deploy-key: r1681manualsuspend
--
-- R-1681 (P1 money, 19 Oct 2026) — a subscription paused BY HAND stayed paused after the
-- customer paid, and nobody was asked why it was paused.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Staging release check, story 18 (T-18, INV-5F40-27-0080): Payments → Subscription dues →
--   Suspend → "Pause" wrote only status = 'paused' (useSuspendSubscription, a bare row update):
--   no reason, no suspended_by, no invoice. Correct details → status paused did the same. The
--   ₹3,823 UPI payment then settled the invoice, but trg_invoices_overdue_resume
--   (20261007281600) only turns back on pauses with suspended_by = 'automation' and that
--   invoice in suspended_invoice_id — so the paying customer stayed paused.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   * suspend_subscription(id, reason, for_unpaid): the one way a person pauses a subscription.
--     Reason required (stored in suspend_reason; the activity log records the change through
--     trg_activity_subscriptions). With for_unpaid, the server links the OLDEST unpaid invoice
--     of that subscription (its quote, its renewal quote, its instalment billings) and sets
--     resume_when_paid — so paying that invoice turns the service back on exactly like the
--     automatic pause. No unpaid invoice → refused with the next step.
--   * subscriptions.resume_when_paid (default false): a person's pause comes back on payment
--     ONLY when they said it was for that unpaid invoice. A pause for any other reason (and
--     every pause written before today) is still never undone by a payment — R-116's rule.
--   * trg_invoices_overdue_resume: also resumes suspended_by = 'user' rows with
--     resume_when_paid, logs it in ai_action_log, and tells the owner/managers in the bell
--     ("turn the licences back on at Google / Microsoft too" — the app never touches them).
--   * trg_subscriptions_pause_reason: a signed-in person who pauses by a direct row update
--     (Correct details, any old screen) must give suspend_reason; suspended_by/at are filled
--     in. Crons and service-role writes (auth.uid() null) are unchanged. Leaving 'paused' for
--     'active' clears the pause fields.
--
-- Test: supabase/tests/r1681_manual_suspend_resume.test.sql (+ overdue_auto_suspend.test.sql)

alter table public.subscriptions
  add column if not exists resume_when_paid boolean not null default false;

comment on column public.subscriptions.resume_when_paid is
  'R-1681: a person paused this subscription because suspended_invoice_id was unpaid — paying that invoice turns it back on (trg_invoices_overdue_resume). False for every other pause.';

-- ── 1. A person's pause needs a reason ─────────────────────────────────────────
create or replace function public.tg_subscriptions_pause_reason()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1681 */
begin
  if new.status::text = 'paused' and old.status::text is distinct from 'paused' then
    if auth.uid() is not null then
      if length(trim(coalesce(new.suspend_reason, ''))) < 3 then
        raise exception 'Write why this subscription is being paused (for example "Invoice INV-… unpaid"). The reason is kept in the activity log.'
          using errcode = '23514';
      end if;
      new.suspended_by := coalesce(new.suspended_by, 'user');
    end if;
    new.suspended_at := coalesce(new.suspended_at, now());
  elsif old.status::text = 'paused' and new.status::text = 'active' then
    new.suspended_at := null;
    new.suspend_reason := null;
    new.suspended_by := null;
    new.suspended_invoice_id := null;
    new.resume_when_paid := false;
  end if;
  return new;
end;
$function$;

comment on function public.tg_subscriptions_pause_reason() is
  'R-1681: a signed-in person pausing a subscription must give suspend_reason; resuming clears the pause fields.';

revoke all on function public.tg_subscriptions_pause_reason() from public, anon;

drop trigger if exists trg_subscriptions_pause_reason on public.subscriptions;
create trigger trg_subscriptions_pause_reason
  before update of status on public.subscriptions
  for each row execute function public.tg_subscriptions_pause_reason();

-- ── 2. The pause a person makes ───────────────────────────────────────────────
create or replace function public.suspend_subscription(
  p_subscription_id uuid,
  p_reason          text,
  p_for_unpaid      boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1681: pause with a reason; optionally tied to the unpaid invoice so payment resumes it. */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean;
  v_sub     record;
  v_inv_id  text;
  v_inv_due integer;
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company context — sign in again, then pause the subscription.' using errcode = '28000';
  end if;
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can pause a subscription. Ask one of them.'
      using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Write why this subscription is being paused (for example "Invoice unpaid for 20 days"). The reason is kept in the activity log.'
      using errcode = '22023';
  end if;

  select s.id, s.tenant_id, s.status::text as status, s.quote_id, s.renewal_quote_id, s.customer_name
    into v_sub
    from public.subscriptions s
   where s.id = p_subscription_id
   for update;
  if not found or v_sub.tenant_id <> v_tenant then
    raise exception 'That subscription was not found in your company. Refresh the page and try again.'
      using errcode = '42501';
  end if;
  if v_sub.status not in ('active', 'paused') then
    raise exception 'This subscription is %, so it cannot be paused. Only an active subscription can be paused.', v_sub.status
      using errcode = '22023';
  end if;

  if coalesce(p_for_unpaid, false) then
    select i.id,
           greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0))
      into v_inv_id, v_inv_due
      from public.invoices i
     where i.tenant_id = v_tenant
       and i.status::text in ('pending', 'overdue')
       and greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) > 0
       and (   (v_sub.quote_id is not null and i.quote_id = v_sub.quote_id)
            or (v_sub.renewal_quote_id is not null and i.quote_id = v_sub.renewal_quote_id)
            or exists (select 1 from public.subscription_billings b
                        where b.subscription_id = v_sub.id and b.tenant_id = v_tenant and b.invoice_id = i.id))
     order by i.due_date nulls last, i.invoice_date nulls last, i.id
     limit 1;
    if not found then
      raise exception 'No unpaid invoice was found for this subscription, so it cannot be tied to one. Untick "unpaid invoice" and pause it with your reason, or record the missing invoice first.'
        using errcode = '22023';
    end if;
  end if;

  update public.subscriptions s
     set status               = 'paused',
         suspended_at         = now(),
         suspend_reason       = left(v_reason, 500),
         suspended_by         = 'user',
         suspended_invoice_id = v_inv_id,
         resume_when_paid     = coalesce(p_for_unpaid, false)
   where s.id = v_sub.id;

  return jsonb_build_object(
    'subscription_id', v_sub.id,
    'status', 'paused',
    'reason', left(v_reason, 500),
    'invoice_id', v_inv_id,
    'invoice_due', v_inv_due,
    'resume_when_paid', coalesce(p_for_unpaid, false));
end;
$function$;

comment on function public.suspend_subscription(uuid, text, boolean) is
  'R-1681: a person pauses a subscription with a reason; with p_for_unpaid the oldest unpaid invoice is linked and paying it turns the subscription back on. Owner/manager/accountant/billing; tenant fail-closed.';

revoke all on function public.suspend_subscription(uuid, text, boolean) from public, anon;
grant execute on function public.suspend_subscription(uuid, text, boolean) to authenticated, service_role;

-- ── 3. Paying the invoice turns it back on ────────────────────────────────────
create or replace function public.tg_invoice_overdue_resume()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
/* R-116 automatic pause; R-1681: also a person's pause made "for this unpaid invoice". */
declare
  v_due integer;
begin
  v_due := case
    when new.status::text in ('paid', 'void') then 0
    else greatest(0, coalesce(new.net_payable, new.amount, 0) - coalesce(new.paid_amount, 0))
  end;
  if v_due > 0 then
    return new;
  end if;

  with resumed as (
    update public.subscriptions s
       set status = 'active',
           suspended_at = null,
           suspend_reason = null,
           suspended_by = null,
           suspended_invoice_id = null,
           resume_when_paid = false
      from (select p.id, p.suspended_by
              from public.subscriptions p
             where p.tenant_id = new.tenant_id
               and p.suspended_invoice_id = new.id
               and p.status = 'paused'
               and (p.suspended_by = 'automation' or (p.suspended_by = 'user' and p.resume_when_paid))) o
     where s.id = o.id
    returning s.id, s.customer_name, s.plan, o.suspended_by as paused_by
  ), logged as (
    insert into public.ai_action_log (tenant_id, action, outcome, reason, mode, entity, entity_id, facts)
    select new.tenant_id, 'subscription.overdue_resume', 'did',
           format('Invoice %s is settled, so the service for %s was turned back on.', new.id, r.customer_name),
           'auto', 'subscription', r.id::text,
           jsonb_build_object('invoice_id', new.id, 'invoice_status', new.status::text, 'actor', 'automation',
                              'paused_by', coalesce(r.paused_by, 'automation'))
      from resumed r
    returning entity_id
  )
  insert into public.notifications (tenant_id, user_id, kind, title, body, href, entity_id)
  select new.tenant_id, u.id, 'subscription.resumed',
         left(format('Paisa aa gaya — %s chalu ho gayi', r.customer_name), 200),
         left(format('Invoice %s is paid, so %s (%s) is active again in the app. Turn the licences back on in the Google / Microsoft admin too.',
                     new.id, r.customer_name, coalesce(r.plan, 'subscription')), 500),
         '/subscriptions', r.id::text
    from resumed r
    join public.users u on u.tenant_id = new.tenant_id and u.is_active and u.role in ('owner', 'manager', 'billing');

  return new;
end;
$$;

revoke all on function public.tg_invoice_overdue_resume() from public;
revoke all on function public.tg_invoice_overdue_resume() from anon;
grant execute on function public.tg_invoice_overdue_resume() to authenticated, service_role;
