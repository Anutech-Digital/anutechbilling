-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.nav_badges(text[])') and prosrc like '%R-2431%')
-- deploy-key: r2431navbadgesrenewalstabs
-- 20261103204658_r2431_nav_badges_renewals_tabs.sql
--
-- R-2431 (after R-2422 — Pardeep, 3 Nov 2026: "monthly commitment to renewal hi hoga"): the sidebar Renewals badge equals the
-- /renewals Overdue + ≤7 days tab counts again (Won't renew rows aside, R-2225). R-2422 lists flex (monthly-commitment) subscriptions on Renewals by their next
-- monthly billing date, but nav_badges() still left them out (R-2232), so the badge could read fewer than the tabs. Now, row for
-- row with lib/renewals/buckets.ts inRenewalsBadge (classify.ts + queue.ts queueTabs):
--   * a flex subscription counts like any other row;
--   * a Won't renew row (auto_renew off) stays out, as R-2225 decided (not a renewal to chase) — the ≤7 days tab still lists it
--     with its Non-renewing chip, so the badge = Overdue + ≤7 days less those rows;
--   * a past-date row whose renewal quote is paid (payment_status received) is not Overdue (R-2403 renewedPaid), unless stopped.
-- Body = the latest definition (20261101165305_r2232_nav_badges_flex_parts.sql); only the renewals count and comments change.
-- Only a badge count changes: no prices, quotes, invoices or payments. Tests: supabase/tests/r2431_nav_badges_tabs.test.sql,
-- lib/hooks/nav-badge-parity.test.ts.

begin;

-- ── nav_badges — R-2232 body; 'renewals' = the Renewals page's Overdue + ≤7 days tabs (R-2431) ──
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

  /* R-2225: a non-renewing subscription (auto_renew off — Won't renew) is not a renewal to chase (kept by R-2431). */
  /* R-2431 (after R-2422 — Pardeep, 3 Nov: "monthly commitment to renewal hi hoga"): renewals = the /renewals Overdue + ≤7 days tabs,
     row for row, less the Won't renew rows (lib/renewals/buckets.ts inRenewalsBadge): a flex subscription counts like any row
     (R-2232's exclusion is gone); a past-date row whose renewal quote is paid (payment_status received) is not Overdue unless
     its service is stopped (R-2403 renewedPaid). */
  return jsonb_build_object(
    'leads',     (select count(*) from public.leads l where l.stage in ('new', 'contact', 'lost') and not l.is_junk),
    'enquiries', v_enquiries,
    'deals',     (select count(*) from public.leads l where l.stage in ('quote', 'demo', 'trial', 'won', 'lost') and not l.is_junk),
    'tasks',     (select count(*) from public.tasks t where t.tenant_id = v_tenant and t.status in ('pending', 'snoozed') and t.due_at < v_now),
    'renewals',  (select count(*) from public.subscriptions s where s.status <> 'cancelled' and s.renewal_date is not null and s.auto_renew and s.renewal_date <= v_today + 7 and not (s.renewal_date < v_today and s.renewal_state <> 'suspended' and exists (select 1 from public.quotes rq where rq.id = s.renewal_quote_id and rq.payment_status = 'received'))),
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
  'S16 + R-1475 + R-1541 + R-1635 (written-off invoices are not unpaid) + R-2023 (a customer advance is not "paid, invoice not raised") + R-2225 (a non-renewing subscription is not a renewal to chase) + R-2431 (renewals = the Renewals page''s Overdue + ≤7 days tabs, Won''t renew aside; flex subscriptions count, R-2422 reverses R-2232): every sidebar badge count in one call. SECURITY INVOKER — RLS decides what is counted. leads / deals = the page''s All view; tasks, renewals, invoices, enquiries, payments, quotes = what still needs doing, equal to the filtered view the badge opens (lib/hooks/nav-badge-views.ts).';

commit;
