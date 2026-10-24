-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.today_inbox()') and prosrc like '%R-1635%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.nav_badges(text[])') and prosrc like '%written_off_at%')
-- deploy-key: r1635badgesinbox
--
-- R-1635, part 2 (part 1: 20261023184545_r1635_write_off_invoices adds invoices.written_off_at
-- and write_off_subscription). A written-off invoice is not chased, so the two SQL readers of
-- "unpaid / overdue invoices" leave it out, the same as the TS rule (invoiceAmountDue,
-- invoiceBalance, invoiceIsOverdue):
--
--   nav_badges()   the Invoices badge (= /invoices?focus=unpaid, kpis.ts invoiceInFocus)
--   today_inbox()  "Overdue invoice" items
--
-- Each body is the latest one verbatim (nav_badges: 20261018211844_r1541_nav_badges_attention;
-- today_inbox: 20260928160000_today_inbox) plus `written_off_at is null`. Both stay SECURITY
-- INVOKER with the same grants. Idempotent.
-- Tests: src/lib/hooks/nav-badge-parity.test.ts (reads this file),
--        supabase/tests/r1635_write_off_subscription.test.sql, nav_badges.test.sql,
--        today_inbox.test.sql.

begin;

-- 1. ── nav_badges(): R-1541's body; the invoices count skips written-off invoices ────────

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

  return jsonb_build_object(
    'leads',     (select count(*) from public.leads l where l.stage in ('new', 'contact', 'lost') and not l.is_junk),
    'enquiries', v_enquiries,
    'deals',     (select count(*) from public.leads l where l.stage in ('quote', 'demo', 'trial', 'won', 'lost') and not l.is_junk),
    'tasks',     (select count(*) from public.tasks t where t.tenant_id = v_tenant and t.status in ('pending', 'snoozed') and t.due_at < v_now),
    'renewals',  (select count(*) from public.subscriptions s where s.status <> 'cancelled' and s.renewal_date is not null and s.renewal_date <= v_today + 7),
    'invoices',  (select count(*) from public.invoices i where i.status in ('pending', 'overdue') and coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0) > 0 and i.written_off_at is null),
    'payments',  (select count(*) from public.quotes q where q.payment_status = 'received'),
    'quotes',    v_quotes
  );
end;
$$;

revoke all on function public.nav_badges(text[]) from public;
revoke all on function public.nav_badges(text[]) from anon;
grant execute on function public.nav_badges(text[]) to authenticated;

comment on function public.nav_badges(text[]) is
  'S16 + R-1475 + R-1541 + R-1635 (written-off invoices are not unpaid): every sidebar badge count in one call. SECURITY INVOKER — RLS decides what is counted. leads / deals = the page''s All view; tasks, renewals, invoices, enquiries, payments, quotes = what still needs doing, equal to the filtered view the badge opens (lib/hooks/nav-badge-views.ts).';

-- 2. ── today_inbox(): 20260928160000's body; overdue invoices skip written-off ones ───────
create or replace function public.today_inbox()
returns table (
  kind     text,
  id       text,
  title    text,
  due_at   timestamptz,
  priority int,
  href     text
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  with me as (
    select u.id as uid, u.tenant_id, u.role::text as role,
           (now() at time zone 'Asia/Kolkata')::date as today_ist,
           /* End of the IST day, as an instant. */
           (((now() at time zone 'Asia/Kolkata')::date + 1)::timestamp at time zone 'Asia/Kolkata') as eod
      from public.users u
     where u.id = auth.uid()
       and u.tenant_id = public.current_tenant_id()
  ),
  items (kind, id, title, due_at, priority, href) as (
    -- 1. My tasks — overdue or due by the end of today.
    (select 'task'::text, t.id::text, t.title, t.due_at,
            case when t.due_at < now() then 70 else 55 end, '/tasks'::text
       from public.tasks t, me
      where t.tenant_id = me.tenant_id
        and t.owner_id = me.uid
        and t.status in ('pending', 'snoozed')
        and t.due_at < me.eod
      order by t.due_at
      limit 50)

    union all
    -- 2. Enquiries — unread, still in the Inbox (not done, not snoozed, not machine mail).
    (select 'enquiry', e.id::text,
            'Enquiry: ' || coalesce(nullif(e.subject, ''), '(no subject)')
              || ' — ' || coalesce(nullif(e.from_name, ''), e.from_email, 'unknown sender'),
            e.created_at, 60, '/enquiries'
       from public.inbound_emails e, me
      where e.tenant_id = me.tenant_id
        and e.status in ('received', 'lead_created', 'appended_to_lead')
        and e.read_at is null
        and e.archived_at is null
        and (e.snoozed_until is null or e.snoozed_until <= now())
        and e.created_at > now() - interval '14 days'
      order by e.created_at
      limit 50)

    union all
    -- 3. WhatsApp — conversations whose LAST message is theirs, in the last 7 days.
    (select 'whatsapp', w.contact_phone,
            'WhatsApp from ' || w.contact_phone || coalesce(': ' || left(w.text_body, 60), ''),
            w.created_at, 60, '/whatsapp'
       from (select distinct on (m.contact_phone) m.contact_phone, m.direction, m.text_body, m.created_at
               from public.whatsapp_messages m, me
              where m.tenant_id = me.tenant_id
                and m.created_at > now() - interval '7 days'
              order by m.contact_phone, m.created_at desc) w
      where w.direction = 'inbound'
      order by w.created_at
      limit 50)

    union all
    -- 4. Support tickets we owe a move on (awaiting_customer is THEIR move).
    (select 'support', s.id,
            'Ticket ' || s.id || ': ' || coalesce(s.subject, '') || coalesce(' — ' || s.customer_name, ''),
            s.sla_due_at,
            case when s.sla_due_at < now() then 80
                 when s.priority in ('urgent', 'high') then 65
                 else 55 end,
            '/support'
       from public.support_tickets s, me
      where s.tenant_id = me.tenant_id
        and s.status in ('open', 'in_progress')
      order by s.sla_due_at nulls last
      limit 50)

    union all
    -- 5. Automation held for a human, last 7 days (the /automation "waiting on you" list).
    (select 'automation', a.id::text,
            'Held for you: ' || a.action || coalesce(' — ' || a.reason, ''),
            a.created_at, 50, '/automation'
       from public.ai_action_log a, me
      where a.tenant_id = me.tenant_id
        and a.outcome = 'held'
        and a.created_at > now() - interval '7 days'
      order by a.created_at
      limit 50)

    union all
    -- 6. Activation queue — paid for, not switched on.
    (select 'provisioning', p.id::text,
            case when p.status = 'failed' then 'Activation FAILED: ' else 'Activate: ' end
              || p.seats || ' × ' || coalesce(p.plan, p.vendor) || coalesce(' for ' || p.domain, ''),
            p.created_at,
            case when p.status = 'failed' then 90
                 when p.created_at < now() - interval '24 hours' then 85
                 else 75 end,
            '/provisioning'
       from public.provisioning_requests p, me
      where p.tenant_id = me.tenant_id
        and p.status in ('queued', 'failed')
      order by p.created_at
      limit 50)

    union all
    -- 7. Purchases inbox — vendor order mails not yet booked.
    (select 'purchase_inbox', ip.id::text,
            'Book purchase: ' || coalesce(nullif(ip.subject, ''), ip.source)
              || coalesce(' · ₹' || to_char(ip.total, 'FM99,99,99,99,999'), ''),
            ip.created_at, 30, '/purchases/inbox'
       from public.inbound_purchases ip, me
      where ip.tenant_id = me.tenant_id
        and ip.status = 'pending'
      order by ip.created_at
      limit 50)

    union all
    -- 8a. Quotes waiting on MY approval — mirrors useNavBadges / awaitsMyApproval:
    --     pending, not raised by me, and a tier my role may clear.
    (select 'approval', q.id,
            'Approve quote ' || q.id || coalesce(' — ' || q.customer_name, '')
              || coalesce(' · ₹' || to_char(q.amount, 'FM99,99,99,99,999'), ''),
            q.approval_requested_at, 70, '/quotes/' || q.id
       from public.quotes q, me
      where q.tenant_id = me.tenant_id
        and q.approval_status = 'pending'
        and q.approval_requested_by is distinct from me.uid
        and ( (q.approval_tier = 'owner'   and me.role = 'owner')
           or (q.approval_tier = 'manager' and me.role in ('owner', 'manager')) )
      order by q.approval_requested_at
      limit 50)

    union all
    -- 8b. Seat-change requests from customers (decided on /subscriptions).
    (select 'approval', sr.id::text,
            'Seat change: ' || coalesce(sr.customer_name, 'customer') || ' '
              || sr.current_seats || ' → ' || sr.requested_seats,
            sr.created_at, 60, '/subscriptions'
       from public.seat_requests sr, me
      where sr.tenant_id = me.tenant_id
        and sr.status = 'pending'
        and me.role in ('owner', 'manager', 'billing')
      order by sr.created_at
      limit 50)

    union all
    -- 8c. Expense claims against an advance, waiting for a decision.
    (select 'approval', ec.id::text,
            'Expense claim: ₹' || to_char(ec.amount, 'FM99,99,99,99,999') || coalesce(' — ' || ec.purpose, ''),
            ec.created_at, 40, '/accounting/loans'
       from public.expense_claims ec, me
      where ec.tenant_id = me.tenant_id
        and ec.status = 'pending'
        and me.role in ('owner', 'manager')
      order by ec.created_at
      limit 50)

    union all
    -- 9. Join requests — somebody signed up with our domain and is waiting to be let in.
    (select 'join_request', jr.id::text,
            'Join request: ' || coalesce(nullif(jr.full_name, ''), jr.email) || ' (' || jr.email || ')',
            jr.created_at, 65, '/team'
       from public.join_requests jr, me
      where jr.tenant_id = me.tenant_id
        and jr.status = 'pending_approval'
        and me.role in ('owner', 'manager')
      order by jr.created_at
      limit 50)

    union all
    -- 10. Renewals in the next 14 days (or already past) that nobody has renewed.
    (select 'renewal', su.id::text,
            'Renewal: ' || coalesce(su.customer_name, '') || ' · ' || coalesce(su.plan, '')
              || coalesce(' · ' || su.domain, '') || ' on ' || to_char(su.renewal_date, 'DD Mon'),
            (su.renewal_date::timestamp at time zone 'Asia/Kolkata'),
            case when su.renewal_date <= me.today_ist + 3 then 75
                 when su.renewal_date <= me.today_ist + 7 then 60
                 else 45 end,
            '/renewals'
       from public.subscriptions su, me
      where su.tenant_id = me.tenant_id
        and su.status = 'active'
        and su.renewal_date <= me.today_ist + 14
        and su.renewal_state is distinct from 'renewed'
      order by su.renewal_date
      limit 50)

    union all
    -- 11. Overdue invoices — unpaid and past their due date (IST).
    (select 'invoice_overdue', i.id,
            'Overdue ' || (me.today_ist - i.due_date) || 'd: ' || i.id || coalesce(' — ' || i.customer_name, '')
              || ' (invoice ₹' || to_char(i.amount, 'FM99,99,99,99,999') || ')',
            (i.due_date::timestamp at time zone 'Asia/Kolkata'),
            case when i.due_date < me.today_ist - 30 then 80 else 72 end,
            '/invoices/' || i.id
       from public.invoices i, me
      where i.tenant_id = me.tenant_id
        and i.status in ('pending', 'overdue')
        and i.written_off_at is null   -- R-1635: written off = not chased
        and i.due_date < me.today_ist
      order by i.due_date
      limit 50)

    union all
    -- 12. Autopay stopped — Razorpay halted the mandate (repeated failed charges) or it is
    --     stuck pending. The only durable record of a failed payment this schema keeps:
    --     the webhook ignores one-off `payment.failed` events (webhooks/razorpay/route.ts).
    (select 'payment_failed', pm.id::text,
            'Autopay stopped: ' || coalesce(c.name, 'customer') || coalesce(' — ' || pm.status_note, ''),
            pm.updated_at, 85, '/subscriptions'
       from public.payment_mandates pm
       join me on pm.tenant_id = me.tenant_id
       left join public.customers c on c.id = pm.customer_id and c.tenant_id = pm.tenant_id
      where pm.status = 'paused'
        and coalesce(pm.test_mode, false) = false
      order by pm.updated_at
      limit 50)
  )
  select i.kind, i.id, i.title, i.due_at, i.priority, i.href from items i
   order by i.priority desc, i.due_at asc nulls last, i.kind, i.id;
$fn$;

comment on function public.today_inbox() is
  'S29 /today: one ranked, read-only list of every queue that wants a person today. SECURITY INVOKER — RLS of each table applies; explicit tenant_id = current_tenant_id() on every branch. See migration 20260928160000.';

revoke all on function public.today_inbox() from public;
revoke all on function public.today_inbox() from anon;
grant execute on function public.today_inbox() to authenticated;

commit;
