-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.set_subscription_non_renewing(uuid,boolean,text,date)') and prosrc like '%R-2225%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.nav_badges(text[])') and prosrc like '%R-2225%')
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
--   3. nav_badges — R-2023 body (20261027110131), copied exactly; 'renewals' leaves out
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

-- ── 3. nav_badges — R-2023 body; 'renewals' leaves out a non-renewing subscription (R-2225) ──
create or replace function public.nav_badges(p_approval_tiers text[] default '{}')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_me        uuid := auth.uid();
  v_tenant    uuid := public.current_tenant_id();
  v_now       timestamptz := now();
  -- Today in IST — the renewals page's daysBetween() counts IST calendar days.
  v_today     date := (now() at time zone 'Asia/Kolkata')::date;
  v_quotes    integer := 0;
  v_enquiries integer := 0;
begin
  if v_tenant is null then
    raise exception 'nav_badges: no workspace for this session'
      using errcode = 'insufficient_privilege';
  end if;

  if v_me is not null and coalesce(array_length(p_approval_tiers, 1), 0) > 0 then
    select count(*) into v_quotes
      from public.quotes q
     where q.approval_status = 'pending'
       and q.approval_requested_by <> v_me
       and q.approval_tier::text = any (p_approval_tiers);
  end if;

  select count(*) into v_enquiries
    from (
      select 1
        from (
          select e.read_at,
                 lower(regexp_replace(coalesce(e.from_email, ''), '^\s+|\s+$', '', 'g')) as sender,
                 e.id::text as row_id,
                 lower(btrim(regexp_replace(
                   regexp_replace(
                     regexp_replace(coalesce(e.subject, ''), '^\s+|\s+$', '', 'g'),
                     '^(\s*(re|fw|fwd|aw|sv|vs|rv|res)\s*(\[\d+\])?\s*:\s*)+', '', 'i'),
                   '\s+', ' ', 'g'))) as topic
            from public.inbound_emails e
           where e.archived_at is null
             and (e.snoozed_until is null or e.snoozed_until <= v_now)
             and e.status not in ('skipped_non_enquiry', 'duplicate', 'reply_sent')
        ) m
       group by case when m.sender = '' then 'id:' || m.row_id else m.sender end,
                case when m.sender = '' then '' else m.topic end
      having bool_or(m.read_at is null)
    ) unread;

  /* R-2225: a non-renewing subscription (auto_renew off — Won't renew) is not a renewal to chase. */
  return jsonb_build_object(
    'leads',     (select count(*) from public.leads l where l.stage in ('new', 'contact', 'lost') and not l.is_junk),
    'enquiries', v_enquiries,
    'deals',     (select count(*) from public.leads l where l.stage in ('quote', 'demo', 'trial', 'won', 'lost') and not l.is_junk),
    'tasks',     (select count(*) from public.tasks t where t.tenant_id = v_tenant and t.status in ('pending', 'snoozed') and t.due_at < v_now),
    'renewals',  (select count(*) from public.subscriptions s where s.status <> 'cancelled' and s.auto_renew and s.renewal_date is not null and s.renewal_date <= v_today + 7),
    'invoices',  (select count(*) from public.invoices i where i.status in ('pending', 'overdue') and coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0) > 0 and i.written_off_at is null),
    /* R-2023: a customer advance (R-1863 holder) has no GST invoice to raise. */
    'payments',  (select count(*) from public.quotes q where q.payment_status = 'received'
                     and not public.is_customer_advance_quote(q.plan, q.amount, q.invoice_id, q.line_items)),
    'quotes',    v_quotes
  );
end;
$$;

revoke all on function public.nav_badges(text[]) from public;
revoke all on function public.nav_badges(text[]) from anon;
grant execute on function public.nav_badges(text[]) to authenticated;

comment on function public.nav_badges(text[]) is
  'S16 + R-1475 + R-1541 + R-1635 (written-off invoices are not unpaid) + R-2023 (a customer advance is not "paid, invoice not raised") + R-2225 (a non-renewing subscription is not a renewal to chase): every sidebar badge count in one call. SECURITY INVOKER — RLS decides what is counted. leads / deals = the page''s All view; tasks, renewals, invoices, enquiries, payments, quotes = what still needs doing, equal to the filtered view the badge opens (lib/hooks/nav-badge-views.ts).';

commit;
