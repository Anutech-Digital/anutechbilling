-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.nav_badges(text[])') and prosrc like '%R-2862%')
-- deploy-key: r2862navbadgespartdue
-- 20261116143835_r2862_nav_badges_part_due.sql
--
-- R-2862 (leftovers of R-2858, staging check 16 Nov 2026): the sidebar Renewals badge = the /renewals Overdue + ≤7 days tabs
-- (Won't renew rows aside, R-2225) also for a row whose PART is late or due soon while its renewal date is 8+ days out.
-- R-2858 put such a row in the tab of its part's due date (the Due column's date); nav_badges() still counted by the renewal
-- date alone, so the sidebar could read fewer than the two tabs. Now a row also counts when, by today + 7 (IST):
--   * its renewal's part proforma is with the customer unpaid and due — the page's `sent` part (renewals/last-docs.ts): an
--     open (sent / viewed / accepted), not revised-away, unpaid proforma of the FIRST part of the subscription's newest billed
--     term (not the first term — that is the original sale), lead part or a "Bill together" line (R-2830), and no open unpaid
--     linked renewal quote (that one is the row's document then); due = due_on, else the part's start;
--   * or (billed in parts, service not stopped) a part of the next term is invoiced with money still due — the page's
--     renewalInvoice (renewals/stage-input.ts); due = the invoice's due date, else the part's start.
-- TS side: lib/renewals/buckets.ts inRenewalsBadge(…, dueDays) over due-anchor.ts rowDue().days.
-- Body = the latest definition (20261104000444_r2431_nav_badges_renewals_tabs.sql); only the renewals count and comments change.
-- Only a badge count changes: no prices, quotes, invoices or payments. Tests: supabase/tests/r2862_nav_badges_part_due.test.sql,
-- src/app/(app)/renewals/part-leftovers-r2862.test.ts.

begin;

-- ── nav_badges — R-2431 body; 'renewals' also counts a row by its unpaid part's due date (R-2862) ──
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
    'tasks',     (select count(*) from public.tasks t where t.tenant_id = v_tenant and t.status in ('pending', 'snoozed') and t.due_at < v_now),
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
  'S16 + R-1475 + R-1541 + R-1635 (written-off invoices are not unpaid) + R-2023 (a customer advance is not "paid, invoice not raised") + R-2225 (a non-renewing subscription is not a renewal to chase) + R-2431 (renewals = the Renewals page''s Overdue + ≤7 days tabs, Won''t renew aside; flex subscriptions count, R-2422 reverses R-2232) + R-2862 (renewals also counts a row whose unpaid part is due by today + 7 although its renewal date is later — the tabs'' Due date, R-2858): every sidebar badge count in one call. SECURITY INVOKER — RLS decides what is counted. leads / deals = the page''s All view; tasks, renewals, invoices, enquiries, payments, quotes = what still needs doing, equal to the filtered view the badge opens (lib/hooks/nav-badge-views.ts).';

commit;
