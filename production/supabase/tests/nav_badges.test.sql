-- Regression test: nav_badges() (migration 20260928130000, S16).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/nav_badges.test.sql
--
-- What it proves:
--   1. Each count equals the rows of the view its badge opens (R-1541: /tasks?tab=overdue,
--      /renewals?bucket=urgent, /invoices?focus=unpaid, the Inbox's unread conversations,
--      /quotes?focus=to-invoice, /quotes?approvals=mine), for seeded rows whose right answer
--      is known (one row on each side of every rule) — the same rows and numbers as
--      src/lib/hooks/nav-badge-parity.test.ts, where the pages' own predicates count them.
--   2. The RPC agrees with the same rules run directly under the caller's RLS.
--   3. Tenant isolation: company B's rows never appear in A's counts, and vice versa.
--   4. The approvals badge: only tiers passed in, never my own request, never a NULL
--      requester; no tiers → 0.
--   5. anon cannot execute it; a signed-in account with no workspace gets an error, not 0.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'NAV TEST A', 'nav-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'NAV TEST B', 'nav-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000c1a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nav-a1@example.in'),
  ('aaaaaaaa-0000-0000-0000-00000000c1a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nav-a2@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000c1b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nav-b1@example.in'),
  ('cccccccc-0000-0000-0000-00000000c1c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nav-stranded@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000c1a1', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'nav-a1@example.in', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000c1a2', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'nav-a2@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000c1b1', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'nav-b1@example.in', 'owner');
-- (nav-stranded has an auth account and no public.users row.)

-- ── Company A ────────────────────────────────────────────────────────────────
insert into public.leads (id, tenant_id, company, stage) values
  ('NAVT-A-L1', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A raw 1',   'new'),
  ('NAVT-A-L2', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A raw 2',   'contact'),
  ('NAVT-A-L3', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A deal',    'quote'),
  ('NAVT-A-L4', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A deal 2',  'trial'),
  ('NAVT-A-L5', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A won',     'won'),
  ('NAVT-A-L6', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A lost',    'lost');
-- R-1475: junk never counts on the pages' "All leads" / "All deals", so not on the badges.
insert into public.leads (id, tenant_id, company, stage, is_junk) values
  ('NAVT-A-J1', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A junk',    'new',  true),
  ('NAVT-A-J2', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A junk 2',  'won',  true);

-- R-1541: the rows below are the fixtures of src/lib/hooks/nav-badge-parity.test.ts, where the
-- PAGE's own predicate must find the same numbers this file asserts for nav_badges().

-- Enquiries = Inbox conversations with an unread message (folders.ts inboxUnread) → 5
insert into public.inbound_emails (tenant_id, message_id, status, lead_id, from_email, subject, read_at, archived_at, snoozed_until) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-1',  'received',            null,        'a@x.in',   'Quote please',            null,                       null,                       null),   -- thread a: unread
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-2',  'received',            null,        ' A@x.in ', 'Re: Fwd:  quote  please', now() - interval '1 hour',  null,                       null),   -- same thread a
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-3',  'lead_created',        'NAVT-A-L1', 'b@x.in',   'Hi',                      null,                       null,                       null),   -- thread b: unread (a lead now, still in Inbox)
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-4',  'received',            null,        'c@x.in',   'Read',                    now() - interval '1 hour',  null,                       null),   -- read: no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-5',  'received',            null,        'd@x.in',   'Done',                    null,                       now() - interval '1 hour',  null),   -- archived: no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-6',  'received',            null,        'e@x.in',   'Later',                   null,                       null,                       now() + interval '1 day'),   -- snoozed: no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-7',  'skipped_non_enquiry', null,        'f@x.in',   'Newsletter',              null,                       null,                       null),   -- spam: no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-8',  'reply_sent',          null,        'us@x.in',  'Re: Hi',                  null,                       null,                       null),   -- our reply: no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-9',  'received',            null,        null,       'Quote please',            null,                       null,                       null),   -- no sender: own thread
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-10', 'received',            null,        '',         'Quote please',            null,                       null,                       null),   -- no sender: own thread
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'navt-a-11', 'received',            null,        'g@x.in',   'Snooze over',             null,                       null,                       now() - interval '1 hour');  -- snooze over: back in the Inbox, unread → counts

-- Tasks = /tasks?tab=overdue (task-groups.ts): open, due time passed → 2
insert into public.tasks (tenant_id, title, status, due_at) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A overdue',  'pending',   now() - interval '2 days'),   -- counts
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A snoozed',  'snoozed',   now() - interval '1 hour'),   -- counts (the page lists snoozed tasks too)
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A soon',     'pending',   now() + interval '1 minute'), -- not due yet: no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A later',    'pending',   now() + interval '3 days'),   -- no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A done',     'done',      now() - interval '2 days'),   -- no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A dropped',  'cancelled', now() - interval '2 days');   -- no

-- Renewals = /renewals?bucket=urgent (lib/renewals/buckets.ts): not cancelled, ≤ 7 IST days or lapsed → 3
insert into public.subscriptions (tenant_id, customer_name, plan, vendor, seats, mrr, status, renewal_date) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'P', 'google', 1, 100, 'active',    (now() at time zone 'Asia/Kolkata')::date + 7),   -- counts
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'P', 'google', 1, 100, 'paused',    (now() at time zone 'Asia/Kolkata')::date + 2),   -- counts
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'P', 'google', 1, 100, 'expired',   (now() at time zone 'Asia/Kolkata')::date - 17),  -- lapsed: counts
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'P', 'google', 1, 100, 'active',    (now() at time zone 'Asia/Kolkata')::date + 8),   -- upcoming: no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'P', 'google', 1, 100, 'cancelled', (now() at time zone 'Asia/Kolkata')::date + 1),   -- no
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'P', 'google', 1, 100, 'active',    null);                                           -- no date: no

-- Invoices = /invoices?focus=unpaid (kpis.ts invoiceBalance > 0) → 2
insert into public.invoices (id, tenant_id, customer_name, amount, net_payable, paid_amount, status) values
  ('NAVT-A-I1', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 1000, 1000, 0,    'pending'),   -- counts
  ('NAVT-A-I2', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 1000, null, 400,  'overdue'),   -- part paid: counts
  ('NAVT-A-I3', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 1000, 600,  600,  'pending'),   -- settled: no
  ('NAVT-A-I4', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 1000, 1000, 1000, 'paid'),      -- no
  ('NAVT-A-I5', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 1000, 1000, 0,    'void'),      -- no
  ('NAVT-A-I6', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 1000, 1000, 0,    'draft');     -- no

insert into public.quotes (id, tenant_id, customer_name, payment_status, approval_status, approval_tier, approval_requested_by) values
  ('NAVT-A-Q1', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'received', 'not_required', null, null),                                   -- payments
  ('NAVT-A-Q2', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'none',     'pending', 'manager', 'aaaaaaaa-0000-0000-0000-00000000c1a2'),     -- awaits A1
  ('NAVT-A-Q3', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'none',     'pending', 'owner',   'aaaaaaaa-0000-0000-0000-00000000c1a1'),     -- A1's own: no
  ('NAVT-A-Q4', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'none',     'pending', 'owner',   null),                                      -- no requester: no
  ('NAVT-A-Q5', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'A cust', 'none',     'pending', 'owner',   'aaaaaaaa-0000-0000-0000-00000000c1a2');     -- awaits A1 (owner tier)

-- ── Company B: one of everything, so a leak shows up as an off-by-one in A ──
insert into public.leads (id, tenant_id, company, stage) values
  ('NAVT-B-L1', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'B raw',  'new'),
  ('NAVT-B-L2', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'B deal', 'demo');
insert into public.inbound_emails (tenant_id, message_id, status, lead_id) values
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'navt-b-1', 'received', null);
insert into public.tasks (tenant_id, title, status, due_at) values
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'B overdue', 'pending', now() - interval '1 day');
insert into public.subscriptions (tenant_id, customer_name, plan, vendor, seats, mrr, status, renewal_date) values
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'B cust', 'P', 'google', 1, 100, 'active', current_date + 5);
insert into public.invoices (id, tenant_id, customer_name, amount, status) values
  ('NAVT-B-I1', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'B cust', 100, 'overdue');
insert into public.quotes (id, tenant_id, customer_name, payment_status, approval_status, approval_tier, approval_requested_by) values
  ('NAVT-B-Q1', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'B cust', 'received', 'pending', 'owner', 'bbbbbbbb-0000-0000-0000-00000000c1b1');

-- ── As A1 (owner of A) ───────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000c1a1', 'role', 'authenticated')::text, true);

do $$
declare
  b jsonb := public.nav_badges(array['manager', 'owner']);
begin
  -- 1 + 3: known answers for A (B's rows would make every one of these off by one)
  -- R-1475: leads = New + Contacted + Lost (L1, L2, L6); deals = Quote … Won + Lost (L3–L6); no junk
  if (b->>'leads')::int     <> 3 then raise exception 'FAIL 1 leads: %', b; end if;
  if (b->>'deals')::int     <> 4 then raise exception 'FAIL 1 deals: %', b; end if;
  -- R-1541: each = the filtered view the badge opens (same rows and numbers as nav-badge-parity.test.ts)
  if (b->>'enquiries')::int <> 5 then raise exception 'FAIL 1 enquiries (Inbox unread conversations): %', b; end if;
  if (b->>'tasks')::int     <> 2 then raise exception 'FAIL 1 tasks (Overdue tab): %', b; end if;
  if (b->>'renewals')::int  <> 3 then raise exception 'FAIL 1 renewals (Urgent bucket): %', b; end if;
  if (b->>'invoices')::int  <> 2 then raise exception 'FAIL 1 invoices (Outstanding focus): %', b; end if;
  if (b->>'payments')::int  <> 1 then raise exception 'FAIL 1 payments (paid, not invoiced): %', b; end if;
  -- 4: Q2 (manager) + Q5 (owner); not Q3 (mine), not Q4 (no requester)
  if (b->>'quotes')::int    <> 2 then raise exception 'FAIL 4 quotes (both tiers): %', b; end if;

  -- 2: the RPC equals each view's rule run directly under this caller's RLS
  if (b->>'leads')::int     <> (select count(*) from public.leads where stage in ('new','contact','lost') and not is_junk) then raise exception 'FAIL 2 leads';     end if;
  if (b->>'deals')::int     <> (select count(*) from public.leads where stage in ('quote','demo','trial','won','lost') and not is_junk) then raise exception 'FAIL 2 deals';     end if;
  if (b->>'tasks')::int     <> (select count(*) from public.tasks where status in ('pending','snoozed') and due_at < now()) then raise exception 'FAIL 2 tasks';     end if;
  if (b->>'renewals')::int  <> (select count(*) from public.subscriptions where status <> 'cancelled' and renewal_date <= (now() at time zone 'Asia/Kolkata')::date + 7) then raise exception 'FAIL 2 renewals'; end if;
  if (b->>'invoices')::int  <> (select count(*) from public.invoices where status in ('pending','overdue') and coalesce(net_payable, amount) > coalesce(paid_amount, 0)) then raise exception 'FAIL 2 invoices';  end if;
  if (b->>'payments')::int  <> (select count(*) from public.quotes where payment_status = 'received')         then raise exception 'FAIL 2 payments';  end if;

  -- 4: tier filter is the caller's, and no tiers means no approvals badge
  if (public.nav_badges(array['manager'])->>'quotes')::int <> 1 then raise exception 'FAIL 4 manager-only'; end if;
  if (public.nav_badges(array[]::text[])->>'quotes')::int  <> 0 then raise exception 'FAIL 4 no tiers';     end if;
  if (public.nav_badges()->>'quotes')::int                 <> 0 then raise exception 'FAIL 4 default';      end if;
end $$;

-- ── As B1 (owner of B): sees only B ─────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000c1b1', 'role', 'authenticated')::text, true);
do $$
declare b jsonb := public.nav_badges(array['manager', 'owner']);
begin
  if b <> jsonb_build_object('leads',1,'enquiries',1,'deals',1,'tasks',1,'renewals',1,'invoices',1,'payments',1,'quotes',0) then
    raise exception 'FAIL 3 B sees: %', b;   -- quotes 0: B-Q1 is B1's own request
  end if;
end $$;

-- ── Signed in, no workspace: an error, not a row of zeros ───────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-00000000c1c1', 'role', 'authenticated')::text, true);
do $$
begin
  perform public.nav_badges();
  raise exception 'FAIL 5 stranded account got counts';
exception when insufficient_privilege then null;
end $$;

-- ── anon: no EXECUTE at all ─────────────────────────────────────────────────
reset role;
do $$
begin
  if has_function_privilege('anon', 'public.nav_badges(text[])', 'execute') then
    raise exception 'FAIL 5 anon can execute nav_badges';
  end if;
  if not has_function_privilege('authenticated', 'public.nav_badges(text[])', 'execute') then
    raise exception 'FAIL 5 authenticated cannot execute nav_badges';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.nav_badges(text[])'::regprocedure) then
    raise exception 'FAIL 5 nav_badges must be SECURITY INVOKER';
  end if;
end $$;

select 'nav_badges: PASS' as result;

rollback;
