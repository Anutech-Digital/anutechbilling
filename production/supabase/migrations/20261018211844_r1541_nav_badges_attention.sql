-- deploy-peek: position('R-1541' in coalesce(obj_description(to_regprocedure('public.nav_badges(text[])'), 'pg_proc'), '')) > 0
-- deploy-key: r1541navbadges
--
-- R-1541 (audit 18 Oct 2026, after R-1475): six sidebar badges counted one thing and opened a
-- page that showed another — "Renewals 12" opened the Urgent tab with 3, "Invoices 5" opened
-- every invoice. Manager's decision (decidedBy: manager): a badge stays an ATTENTION signal —
-- it counts what still needs doing — and a click on the badge opens the filtered view that
-- lists exactly those rows (lib/hooks/nav-badge-views.ts). Each count below is that view's
-- own rule, from the TS constant the page filters with:
--
--   tasks      /tasks?tab=overdue        open (pending, snoozed) and due_at already passed
--                                         — task-groups.ts taskGroupOf, TASK_OPEN_STATUSES;
--                                         the page reads only its own tenant's tasks
--   renewals   /renewals?bucket=urgent   not cancelled, has a renewal date, renews within
--                                         RENEWAL_URGENT_DAYS (7) of the IST today, lapsed ones
--                                         included — lib/renewals/buckets.ts
--   invoices   /invoices?focus=unpaid    INVOICE_OWED_STATUSES with a balance left
--                                         (net_payable or amount, less paid_amount) — kpis.ts
--   enquiries  /enquiries?folder=inbox   Inbox CONVERSATIONS with an unread message — the red
--                                         number on the Inbox folder (folders.ts inboxUnread):
--                                         not archived, not snoozed, not spam/system, not our
--                                         own sent reply; grouped by sender + subject with the
--                                         Re:/Fwd: prefixes stripped (threads.ts threadKey)
--   payments   /quotes?focus=to-invoice  quotes paid in full, GST invoice not raised
--                                         (QUOTE_TO_INVOICE_PAYMENT_STATUS) — unchanged
--   quotes     /quotes?approvals=mine    waiting on MY approval — unchanged
--
-- leads / deals are R-1475's body verbatim. Still SECURITY INVOKER (RLS decides what is
-- counted) and fails closed without a workspace (CLAUDE.md §17c). Idempotent.
-- Tests: src/lib/hooks/nav-badge-parity.test.ts reads THIS file against the TS constants;
-- supabase/tests/nav_badges.test.sql (rolled back) seeds rows on each side of every rule.

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
    'invoices',  (select count(*) from public.invoices i where i.status in ('pending', 'overdue') and coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0) > 0),
    'payments',  (select count(*) from public.quotes q where q.payment_status = 'received'),
    'quotes',    v_quotes
  );
end;
$$;

revoke all on function public.nav_badges(text[]) from public;
revoke all on function public.nav_badges(text[]) from anon;
grant execute on function public.nav_badges(text[]) to authenticated;

comment on function public.nav_badges(text[]) is
  'S16 + R-1475 + R-1541: every sidebar badge count in one call. SECURITY INVOKER — RLS decides what is counted. leads / deals = the page''s All view; tasks, renewals, invoices, enquiries, payments, quotes = what still needs doing, equal to the filtered view the badge opens (lib/hooks/nav-badge-views.ts).';
