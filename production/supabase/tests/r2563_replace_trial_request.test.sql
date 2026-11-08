-- R-2563 — replace_trial_request (migration 20261107151134_r2563_replace_trial_request).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2563_replace_trial_request.test.sql
--
-- The owner's case (card R-2563, 7 Nov): website /trial — Business Starter request (lead + draft
-- quote), "← Change the request", Business Standard request. What it proves:
--   1. replace → ONE open lead for the customer; the old draft quote is expired and points at the
--      new quote; a note on both leads.
--   2. a SENT quote on the old lead is never touched — the lead stays open with ONE note (a second
--      call adds no second note).
--   3. another contact (email or mobile differs) / another tenant → nothing written at all.
--   4. a lead a person already worked on (own activity) or older than 24 h → note only, stays open.
--   5. anon and authenticated cannot call it.

begin;

insert into public.tenants (id, name, email) values
  ('c2563000-0000-0000-0000-0000000000a1'::uuid, 'T-R2563 A', 'r2563-a@example.in'),
  ('c2563000-0000-0000-0000-0000000000b1'::uuid, 'T-R2563 B', 'r2563-b@example.in');

insert into public.leads (id, tenant_id, company, contact_email, contact_phone, stage, source, plan, created_at) values
  -- the owner's case: old Starter request, new Standard request
  ('L-R2563OLD',  'c2563000-0000-0000-0000-0000000000a1', 'T Ravi Traders', 'ravi@example.in',   '+91 98765 43210', 'trial', 'website-trial', 'google-workspace-starter',  now() - interval '5 minutes'),
  ('L-R2563NEW',  'c2563000-0000-0000-0000-0000000000a1', 'T Ravi Traders', 'Ravi@Example.in',   '9876543210',      'trial', 'website-trial', 'google-workspace-standard', now()),
  -- old request with a SENT quote
  ('L-R2563SENT', 'c2563000-0000-0000-0000-0000000000a1', 'T Ravi Traders', 'ravi@example.in',   '9876543210',      'trial', 'website-trial', 'google-workspace-starter',  now() - interval '5 minutes'),
  -- another customer's request
  ('L-R2563VIC',  'c2563000-0000-0000-0000-0000000000a1', 'T Victim Co',    'victim@example.in', '9123456780',      'trial', 'website-trial', 'google-workspace-starter',  now() - interval '5 minutes'),
  -- same contact, but a person logged a call on it
  ('L-R2563WORK', 'c2563000-0000-0000-0000-0000000000a1', 'T Ravi Traders', 'ravi@example.in',   '9876543210',      'trial', 'website-trial', 'google-workspace-starter',  now() - interval '5 minutes'),
  -- same contact, two days old
  ('L-R2563AGED', 'c2563000-0000-0000-0000-0000000000a1', 'T Ravi Traders', 'ravi@example.in',   '9876543210',      'trial', 'website-trial', 'google-workspace-starter',  now() - interval '2 days'),
  -- same contact in ANOTHER tenant
  ('L-R2563TB',   'c2563000-0000-0000-0000-0000000000b1', 'T Ravi Traders', 'ravi@example.in',   '9876543210',      'trial', 'website-trial', 'google-workspace-starter',  now() - interval '5 minutes');

insert into public.quotes (id, tenant_id, customer_name, lead_id, status) values
  ('Q-R2563-OLD',  'c2563000-0000-0000-0000-0000000000a1', 'T Ravi Traders', 'L-R2563OLD',  'draft'),
  ('Q-R2563-NEW',  'c2563000-0000-0000-0000-0000000000a1', 'T Ravi Traders', 'L-R2563NEW',  'draft'),
  ('Q-R2563-SENT', 'c2563000-0000-0000-0000-0000000000a1', 'T Ravi Traders', 'L-R2563SENT', 'sent'),
  ('Q-R2563-VIC',  'c2563000-0000-0000-0000-0000000000a1', 'T Victim Co',    'L-R2563VIC',  'draft'),
  ('Q-R2563-TB',   'c2563000-0000-0000-0000-0000000000b1', 'T Ravi Traders', 'L-R2563TB',   'draft');

insert into public.lead_activities (tenant_id, lead_id, kind, detail, created_by) values
  ('c2563000-0000-0000-0000-0000000000a1', 'L-R2563WORK', 'call', 'T rang them', gen_random_uuid());

do $$
declare
  r jsonb;
  n int;
  q record;
  l record;
  t constant uuid := 'c2563000-0000-0000-0000-0000000000a1';
begin
  -- ── 1. the owner's case ───────────────────────────────────────────────────────────────────
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563OLD', 'ravi@example.in', '+919876543210');
  if r->>'action' <> 'close' or r->'quotes' <> '["Q-R2563-OLD"]'::jsonb then
    raise exception 'R-2563 case 1: expected close of Q-R2563-OLD, got %', r;
  end if;
  select * into l from public.leads where id = 'L-R2563OLD';
  if not l.is_junk or l.junk_reason <> 'other' or l.junk_note not like 'Replaced by L-R2563NEW%' then
    raise exception 'R-2563 case 1: old lead not closed as replaced: % % %', l.is_junk, l.junk_reason, l.junk_note;
  end if;
  select * into q from public.quotes where id = 'Q-R2563-OLD';
  if q.status <> 'expired' or q.superseded_by is distinct from 'Q-R2563-NEW' then
    raise exception 'R-2563 case 1: old draft quote is % / %', q.status, q.superseded_by;
  end if;
  if (select status from public.quotes where id = 'Q-R2563-NEW') <> 'draft' then
    raise exception 'R-2563 case 1: the new quote changed';
  end if;
  select count(*) into n from public.leads
   where tenant_id = t and lower(contact_email) = 'ravi@example.in' and not is_junk and id in ('L-R2563OLD', 'L-R2563NEW');
  if n <> 1 then raise exception 'R-2563 case 1: % open leads, expected 1', n; end if;
  select count(*) into n from public.lead_activities where lead_id in ('L-R2563OLD', 'L-R2563NEW') and kind = 'note';
  if n <> 2 then raise exception 'R-2563 case 1: % notes, expected 2', n; end if;
  -- again → already closed, nothing more
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563OLD', 'ravi@example.in', '9876543210');
  if r->>'action' <> 'ignore' then raise exception 'R-2563 case 1 repeat: %', r; end if;

  -- ── 2. a sent quote is never touched ──────────────────────────────────────────────────────
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563SENT', 'ravi@example.in', '9876543210');
  if r->>'action' <> 'note' or r->>'why' not like '%Q-R2563-SENT was already sent%' then
    raise exception 'R-2563 case 2: %', r;
  end if;
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563SENT', 'ravi@example.in', '9876543210');
  select * into q from public.quotes where id = 'Q-R2563-SENT';
  if q.status <> 'sent' or q.superseded_by is not null then raise exception 'R-2563 case 2: sent quote changed: %', q.status; end if;
  if (select is_junk from public.leads where id = 'L-R2563SENT') then raise exception 'R-2563 case 2: lead with a sent quote was closed'; end if;
  select count(*) into n from public.lead_activities where lead_id = 'L-R2563SENT';
  if n <> 1 then raise exception 'R-2563 case 2: % notes, expected exactly 1', n; end if;

  -- a draft that went out by email (send-log row) counts as sent
  update public.quotes set status = 'draft' where id = 'Q-R2563-SENT';
  insert into public.quote_send_log (tenant_id, quote_id, recipient_email, status)
  values (t, 'Q-R2563-SENT', 'ravi@example.in', 'sent');
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563SENT', 'ravi@example.in', '9876543210');
  if r->>'action' <> 'note' or (select status from public.quotes where id = 'Q-R2563-SENT') <> 'draft' then
    raise exception 'R-2563 case 2b: emailed draft was touched: %', r;
  end if;

  -- ── 3. another contact / another tenant → nothing written ────────────────────────────────
  select count(*) into n from public.lead_activities where lead_id in ('L-R2563VIC', 'L-R2563TB');
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563VIC', 'ravi@example.in', '9876543210');
  if r->>'action' <> 'ignore' then raise exception 'R-2563 case 3 (contact): %', r; end if;
  -- the forger brings the victim's email but not the mobile (new lead must match too)
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563VIC', 'victim@example.in', '9123456780');
  if r->>'action' <> 'ignore' then raise exception 'R-2563 case 3 (new lead contact): %', r; end if;
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563TB', 'ravi@example.in', '9876543210');
  if r->>'action' <> 'ignore' then raise exception 'R-2563 case 3 (tenant): %', r; end if;
  if (select count(*) from public.leads where id in ('L-R2563VIC', 'L-R2563TB') and is_junk) <> 0
     or (select count(*) from public.quotes where id in ('Q-R2563-VIC', 'Q-R2563-TB') and status <> 'draft') <> 0
     or (select count(*) from public.lead_activities where lead_id in ('L-R2563VIC', 'L-R2563TB')) <> n then
    raise exception 'R-2563 case 3: another customer''s / tenant''s rows were written';
  end if;

  -- ── 4. worked on by a person, or too old → note only ─────────────────────────────────────
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563WORK', 'ravi@example.in', '9876543210');
  if r->>'action' <> 'note' or (select is_junk from public.leads where id = 'L-R2563WORK') then
    raise exception 'R-2563 case 4 (worked): %', r;
  end if;
  r := public.replace_trial_request(t, 'L-R2563NEW', 'Q-R2563-NEW', 'L-R2563AGED', 'ravi@example.in', '9876543210');
  if r->>'action' <> 'note' or r->>'why' not like '%older than 24 hours%' then
    raise exception 'R-2563 case 4 (aged): %', r;
  end if;

  -- ── 5. only the service role may call it ─────────────────────────────────────────────────
  if has_function_privilege('anon', 'public.replace_trial_request(uuid,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.replace_trial_request(uuid,text,text,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.replace_trial_request(uuid,text,text,text,text,text)', 'execute') then
    raise exception 'R-2563 case 5: execute grants are wrong';
  end if;

  raise notice 'R-2563 replace_trial_request: all cases passed';
end $$;

rollback;
