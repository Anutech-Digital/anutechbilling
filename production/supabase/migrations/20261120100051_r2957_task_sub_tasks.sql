-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'parent_task_id') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'is_goal') and exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'tasks_goal_guard') and exists(select 1 from pg_trigger t where t.tgname = 'trg_tasks_goal_guard' and t.tgrelid = to_regclass('public.tasks') and t.tgenabled <> 'D') and to_regclass('public.idx_tasks_tenant_parent') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'nav_badges' and p.prosrc like '%not t.is_goal%') and exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'today_inbox' and p.prosrc like '%not t.is_goal%')
-- deploy-key: r2957tasksubtasks
-- R-2957 (epic TASK-GOALS, card 1 of 4): a task can have sub-tasks — the base for goals.
-- A goal is not a new thing: it is the same task row with sub-tasks under it. No screen changes here
-- (R-2958..R-2960 build them); nothing changes for today's rows (parent null, is_goal false).
--
-- 1. Columns on public.tasks (additive):
--      parent_task_id uuid null → public.tasks(id) ON DELETE SET NULL (deleting a goal leaves its
--        sub-tasks as separate tasks; cancelling them with it is the screen's choice, R-2960);
--      is_goal boolean not null default false — true for a task that is a goal. A task with
--        sub-tasks is always a goal; a goal may have none yet (just converted, or all moved out).
--    Indexes (only rows that have a parent): (tenant_id, parent_task_id) for the lists, and
--    (parent_task_id) for the foreign key's own lookup when a task is deleted.
--
-- 2. public.tasks_goal_guard() — BEFORE INSERT, and UPDATE of parent_task_id / is_goal / tenant_id,
--    on tasks. For EVERY writer (also the server), only when one of the three really changes:
--      a. a task cannot be its own sub-task (23514);
--      b. a goal cannot be a sub-task — a row marked is_goal, or one that has sub-tasks, cannot get
--         a parent; a sub-task cannot be marked a goal (23514);
--      c. the parent must be a task of the row's own company. One message and one SQLSTATE (23503)
--         for "another company's task" and "does not exist", raised BEFORE the foreign key is
--         checked — the answer does not tell whether a uuid exists somewhere else. (A signed-in
--         user's lookup runs under their own row-level security: another company's task simply is
--         not there for them.)
--      d. one level only: the parent cannot itself be a sub-task (23514);
--      e. the first sub-task turns its parent into a goal (is_goal := true) in the same write;
--      f. is_goal cannot be cleared while the task still has sub-tasks (23514);
--      g. a task with sub-tasks cannot move to another company (23503).
--    Two writes at the same moment: the parent row is locked (FOR NO KEY UPDATE) and read again
--    under the lock before (d) and (e); a row that is itself being changed is already locked by
--    its own UPDATE. So "X goes under P" and "C goes under X" cannot both pass, and "clear is_goal
--    on X" and "C goes under X" go one after the other (plpgsql reads fresh rows per statement
--    under READ COMMITTED). SECURITY INVOKER — no role is asked: the rules hold for everyone.
--    The foreign key's own "parent → NULL" when a goal is deleted passes (nothing to check).
--
-- 3. The two SQL counters skip the goal row (its sub-tasks ARE the work and are counted like any
--    task — counting the goal too would count the same work twice):
--      nav_badges(text[]).tasks — body = the latest definition (20261116143835_r2862_nav_badges_part_due.sql),
--        only the 'tasks' line gains "and not t.is_goal";
--      today_inbox() — body = the latest definition (20261023184546_r1635_badges_inbox_written_off.sql),
--        only branch 1 (My tasks) gains "and not t.is_goal".
--    Until R-2958 ships nobody can make a goal from a screen, so both return today's numbers.
--
-- RLS policies of tasks are not touched. No data is changed. Safe to re-run.
-- Tests: supabase/tests/r2957_task_sub_tasks.test.sql (rolled back).
begin;

-- ── 1. columns + indexes ────────────────────────────────────────────────────────────
alter table public.tasks
  add column if not exists parent_task_id uuid,
  add column if not exists is_goal boolean not null default false;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_parent_task_id_fkey' and conrelid = to_regclass('public.tasks')) then
    alter table public.tasks
      add constraint tasks_parent_task_id_fkey foreign key (parent_task_id) references public.tasks(id) on delete set null;
  end if;
end
$do$;

comment on column public.tasks.parent_task_id is
  'R-2957: the goal this task is a sub-task of (a task of the same company, one level only — public.tasks_goal_guard). NULL = a separate task. Deleting the goal sets it back to NULL.';
comment on column public.tasks.is_goal is
  'R-2957: this task is a goal — its sub-tasks are the work. Always true while it has sub-tasks. A goal row is not counted in task counts, lists of work or points; its sub-tasks are.';

create index if not exists idx_tasks_tenant_parent on public.tasks (tenant_id, parent_task_id) where parent_task_id is not null;
create index if not exists idx_tasks_parent on public.tasks (parent_task_id) where parent_task_id is not null;

-- ── 2. the guard ────────────────────────────────────────────────────────────────────
create or replace function public.tasks_goal_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_parent_tenant uuid;
  v_parent_parent uuid;
  v_parent_goal   boolean;
begin
  -- R-2957. Nothing of ours changed (an UPDATE that only names the columns) → no reads, no locks.
  if TG_OP = 'UPDATE'
     and NEW.parent_task_id is not distinct from OLD.parent_task_id
     and NEW.is_goal is not distinct from OLD.is_goal
     and NEW.tenant_id is not distinct from OLD.tenant_id then
    return NEW;
  end if;

  if TG_OP = 'UPDATE' and exists (select 1 from public.tasks c where c.parent_task_id = NEW.id) then
    -- This row has sub-tasks.
    if NEW.parent_task_id is not null then
      raise exception 'R-2957: a goal cannot be a sub-task of another goal'
        using errcode = '23514';
    end if;
    if not NEW.is_goal then
      raise exception 'R-2957: this goal still has sub-tasks — move them out or cancel them first'
        using errcode = '23514';
    end if;
    if NEW.tenant_id is distinct from OLD.tenant_id then
      raise exception 'R-2957: this goal is not in this company'
        using errcode = '23503';
    end if;
  end if;

  if NEW.parent_task_id is null then
    return NEW;
  end if;

  if NEW.parent_task_id = NEW.id then
    raise exception 'R-2957: a task cannot be its own sub-task'
      using errcode = '23514';
  end if;
  if NEW.is_goal then
    raise exception 'R-2957: a goal cannot be a sub-task of another goal'
      using errcode = '23514';
  end if;

  -- Read first, lock after: a row that is refused for the company never holds a lock on a task.
  select t.tenant_id into v_parent_tenant from public.tasks t where t.id = NEW.parent_task_id;
  if v_parent_tenant is distinct from NEW.tenant_id then
    raise exception 'R-2957: this goal is not in this company'
      using errcode = '23503';
  end if;

  -- A second writer for the same parent waits here, then reads what the first one left.
  select t.tenant_id, t.parent_task_id, t.is_goal
    into v_parent_tenant, v_parent_parent, v_parent_goal
    from public.tasks t where t.id = NEW.parent_task_id
     for no key update;
  if v_parent_tenant is distinct from NEW.tenant_id then
    raise exception 'R-2957: this goal is not in this company'
      using errcode = '23503';
  end if;
  if v_parent_parent is not null then
    raise exception 'R-2957: a sub-task cannot have sub-tasks of its own — add this one to the goal instead'
      using errcode = '23514';
  end if;
  if not v_parent_goal then
    -- The first sub-task makes its parent a goal.
    update public.tasks set is_goal = true where id = NEW.parent_task_id;
  end if;
  return NEW;
end
$function$;

comment on function public.tasks_goal_guard() is
  'R-2957: sub-task rules for every writer — parent in the same company (one message, 23503 — no existence oracle), one level only, a goal is never a sub-task, never its own parent, a task with sub-tasks is always is_goal (set with the first sub-task; cannot be cleared while they exist). The parent row is locked while it is checked.';

revoke all on function public.tasks_goal_guard() from public, anon, authenticated;

drop trigger if exists trg_tasks_goal_guard on public.tasks;
create trigger trg_tasks_goal_guard
  before insert or update of parent_task_id, is_goal, tenant_id on public.tasks
  for each row execute function public.tasks_goal_guard();

-- ── 3a. nav_badges — R-2862 body; 'tasks' does not count a goal row (R-2957) ─────────
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
  -- R-2862: subscriptions whose renewal PART is unpaid and due by today + 7 (its proforma with the customer, or its invoice).
  v_part_due  uuid[] := '{}';
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

  /* R-2862: the tabs go by the Due column's date (R-2858), so a row also counts when its unpaid PART is due by today + 7
     although the renewal date is later. Two kinds, as the page reads them:
       (a) the renewal's part proforma with the customer, unpaid (renewals/last-docs.ts `sent`): one pass over the open part
           proformas (few), each with its lead part and its "Bill together" line parts (R-2830) — only the FIRST part of the
           subscription's newest billed term, never the first term (the original sale), and not when an open unpaid renewal
           quote is linked (that quote is the row's document then);
       (b) billed in parts, service not stopped: a part of the next term invoiced with money still due (stage-input.ts renewalInvoice). */
  select coalesce(array_agg(distinct d.subscription_id), '{}') into v_part_due
    from (
      select b.subscription_id
        from public.quotes pq
       cross join lateral (
              select pq.subscription_billing_id as billing_id
              union
              select (l.item->>'billing_id')::uuid
                from jsonb_array_elements(case when jsonb_typeof(pq.line_items) = 'array' then pq.line_items else '[]'::jsonb end) as l(item)
               where l.item->>'billing_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            ) x
        join public.subscription_billings b on b.id = x.billing_id
        join public.subscriptions s on s.id = b.subscription_id
       where pq.subscription_billing_id is not null
         and pq.status in ('sent', 'viewed', 'accepted') and pq.superseded_by is null
         and coalesce(pq.payment_status::text, 'none') in ('none', 'awaiting', 'partial')
         and coalesce(b.due_on, b.period_start, b.term_start) <= v_today + 7
         and b.term_start = (select max(b2.term_start) from public.subscription_billings b2 where b2.subscription_id = b.subscription_id)
         and b.period_index = (select min(b3.period_index) from public.subscription_billings b3 where b3.subscription_id = b.subscription_id and b3.term_start = b.term_start)
         and (s.start_date is null or s.start_date < b.term_start)
         and not exists (select 1 from public.quotes oq
                          where oq.id = s.renewal_quote_id and oq.status in ('sent', 'viewed', 'accepted') and oq.superseded_by is null
                            and coalesce(oq.payment_status::text, 'none') in ('none', 'awaiting', 'partial'))
      union
      select b.subscription_id
        from public.subscriptions s
        join public.subscription_billings b on b.subscription_id = s.id
        join public.invoices i on i.id = b.invoice_id
       where s.renewal_date > v_today + 7
         and s.billing_cycle in ('monthly', 'quarterly', 'half_yearly')
         and s.renewal_state <> 'suspended' and s.status not in ('paused', 'expired', 'cancelled')
         and b.period_start >= s.renewal_date
         and i.status in ('pending', 'overdue') and coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0) > 0 and i.written_off_at is null
         and coalesce(i.due_date, b.period_start) <= v_today + 7
    ) d;

  /* R-2225: a non-renewing subscription (auto_renew off — Won't renew) is not a renewal to chase (kept by R-2431). */
  /* R-2431 (after R-2422 — Pardeep, 3 Nov: "monthly commitment to renewal hi hoga"): renewals = the /renewals Overdue + ≤7 days tabs,
     row for row, less the Won't renew rows (lib/renewals/buckets.ts inRenewalsBadge): a flex subscription counts like any row
     (R-2232's exclusion is gone); a past-date row whose renewal quote is paid (payment_status received) is not Overdue unless
     its service is stopped (R-2403 renewedPaid).
     R-2862: or its unpaid part is due by today + 7 (v_part_due above) — the tabs' Due date, R-2858. */
  return jsonb_build_object(
    'leads',     (select count(*) from public.leads l where l.stage in ('new', 'contact', 'lost') and not l.is_junk),
    'enquiries', v_enquiries,
    'deals',     (select count(*) from public.leads l where l.stage in ('quote', 'demo', 'trial', 'won', 'lost') and not l.is_junk),
    /* R-2957: a goal row (is_goal) is not counted — its sub-tasks are the work and are counted like any task. */
    'tasks',     (select count(*) from public.tasks t where t.tenant_id = v_tenant and t.status in ('pending', 'snoozed') and t.due_at < v_now and not t.is_goal),
    'renewals',  (select count(*) from public.subscriptions s where s.status <> 'cancelled' and s.renewal_date is not null and s.auto_renew and (s.renewal_date <= v_today + 7 or s.id = any (v_part_due)) and not (s.renewal_date < v_today and s.renewal_state <> 'suspended' and exists (select 1 from public.quotes rq where rq.id = s.renewal_quote_id and rq.payment_status = 'received'))),
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
  'S16 + R-1475 + R-1541 + R-1635 (written-off invoices are not unpaid) + R-2023 (a customer advance is not "paid, invoice not raised") + R-2225 (a non-renewing subscription is not a renewal to chase) + R-2431 (renewals = the Renewals page''s Overdue + ≤7 days tabs, Won''t renew aside; flex subscriptions count, R-2422 reverses R-2232) + R-2957 (tasks does not count a goal row — its sub-tasks are the work) + R-2862 (renewals also counts a row whose unpaid part is due by today + 7 although its renewal date is later — the tabs'' Due date, R-2858): every sidebar badge count in one call. SECURITY INVOKER — RLS decides what is counted. leads / deals = the page''s All view; tasks, renewals, invoices, enquiries, payments, quotes = what still needs doing, equal to the filtered view the badge opens (lib/hooks/nav-badge-views.ts).';

-- ── 3b. today_inbox — R-1635 body; My tasks does not list a goal row (R-2957) ────────
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
        and not t.is_goal   -- R-2957: a goal's sub-tasks are the work, not the goal row
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
  'S29 /today: one ranked, read-only list of every queue that wants a person today. SECURITY INVOKER — RLS of each table applies; explicit tenant_id = current_tenant_id() on every branch. See migration 20260928160000. R-2957: My tasks leaves out a goal row (its sub-tasks are listed).';

revoke all on function public.today_inbox() from public;
revoke all on function public.today_inbox() from anon;
grant execute on function public.today_inbox() to authenticated;

commit;
